import Foundation
import Network
import os.log

/// Lokal forbindelse (kun 127.0.0.1) mellem filteret og HolyMoly-appen.
/// Protokol: én JSON-besked pr. linje.
///   app -> filter:  {"type":"config","active":true,"until":<ms>,"ai":[…],"block":[…],"dropAi":true}
///                   {"type":"ping"}
///   filter -> app:  {"type":"hello","version":"1.0.0","conn":<id>,"pid":<pid>}
///                   {"type":"state","active":…,"until":…,"by":<conn-id>}   (sendes til ALLE ved ændring)
///                   {"type":"flow","ts":…,"app":"com.microsoft.Word","pid":…,"host":"…","rule":"…","ai":true,"blocked":true}
/// Ændres konfigurationen af en anden forbindelse end HolyMoly-appens egen, ser appen det
/// ("by" passer ikke) og melder manipulation til læreren.
final class ControlServer {
    static let shared = ControlServer()
    static let port: NWEndpoint.Port = 47830
    static let version = "1.0.0"

    private let queue = DispatchQueue(label: "dk.holymoly.filter.control")
    private let lock = NSLock()
    private var _state = FilterState()
    private var listener: NWListener?
    private var clients: [Int: NWConnection] = [:]
    private var buffers: [Int: Data] = [:]
    private var nextId = 1
    private var lastReport: [String: Double] = [:]
    private let log = OSLog(subsystem: "dk.holymoly.filterapp.extension", category: "control")

    var state: FilterState {
        lock.lock(); defer { lock.unlock() }
        return _state
    }

    func start() {
        queue.async {
            guard self.listener == nil else { return }
            let params = NWParameters.tcp
            params.requiredInterfaceType = .loopback
            params.allowLocalEndpointReuse = true
            do {
                let l = try NWListener(using: params, on: ControlServer.port)
                l.newConnectionHandler = { [weak self] c in self?.accept(c) }
                l.stateUpdateHandler = { [weak self] st in
                    if case .failed = st {
                        self?.listener?.cancel()
                        self?.listener = nil
                        self?.queue.asyncAfter(deadline: .now() + 2) { self?.start() }
                    }
                }
                l.start(queue: self.queue)
                self.listener = l
            } catch {
                os_log("Kunne ikke lytte: %{public}@", log: self.log, type: .error, error.localizedDescription)
                self.queue.asyncAfter(deadline: .now() + 2) { self.start() }
            }
        }
    }

    func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            for c in self.clients.values { c.cancel() }
            self.clients.removeAll()
            self.buffers.removeAll()
        }
    }

    private func accept(_ c: NWConnection) {
        // Kun lokale forbindelser
        if case let .hostPort(host, _) = c.endpoint {
            let h = "\(host)"
            if !(h.hasPrefix("127.") || h.hasPrefix("::1")) { c.cancel(); return }
        }
        if clients.count >= 8 { c.cancel(); return }
        let id = nextId
        nextId += 1
        clients[id] = c
        buffers[id] = Data()
        c.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed, .cancelled:
                self?.queue.async { self?.clients[id] = nil; self?.buffers[id] = nil }
            default: break
            }
        }
        c.start(queue: queue)
        send(["type": "hello", "version": ControlServer.version, "conn": id, "pid": Int(getpid())], to: c)
        let s = state
        send(["type": "state", "active": s.isLive, "until": s.until, "by": 0], to: c)
        receive(id, c)
    }

    private func receive(_ id: Int, _ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, complete, error in
            guard let self = self else { return }
            if let data = data, !data.isEmpty {
                var buf = (self.buffers[id] ?? Data()) + data
                if buf.count > 4 * 1024 * 1024 { c.cancel(); return } // beskyt mod misbrug
                while let nl = buf.firstIndex(of: 0x0A) {
                    let line = buf.subdata(in: buf.startIndex..<nl)
                    buf.removeSubrange(buf.startIndex...nl)
                    self.handle(line, from: id, c)
                }
                self.buffers[id] = buf
            }
            if complete || error != nil { c.cancel(); return }
            self.receive(id, c)
        }
    }

    private func handle(_ line: Data, from id: Int, _ c: NWConnection) {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "ping":
            send(["type": "pong"], to: c)
        case "config":
            let strings: (String) -> [String] = { key in
                ((obj[key] as? [Any]) ?? []).compactMap { $0 as? String }.prefix(20000).map { $0 }
            }
            let active = (obj["active"] as? Bool) ?? false
            var until = (obj["until"] as? Double) ?? 0
            let maxUntil = Date().timeIntervalSince1970 * 1000 + 6 * 3600 * 1000 // højst 6 timer frem
            if until > maxUntil { until = maxUntil }
            let new = FilterState(active: active, until: until, ai: strings("ai"), block: strings("block"),
                                  dropAi: (obj["dropAi"] as? Bool) ?? true)
            let old = state
            lock.lock(); _state = new; lock.unlock()
            // Alle får besked om HVER ændring og hvem der lavede den – så HolyMoly-appen opdager
            // hvis et andet program har rørt reglerne (også hvis kun indholdet er byttet ud).
            if old.fingerprint != new.fingerprint {
                broadcast(["type": "state", "active": new.isLive, "until": new.until, "by": id, "fp": new.fingerprint])
            }
        default:
            break
        }
    }

    /// Meldes kun under en lektion og kun for forbudte/AI-forbindelser (dataminimering).
    func report(app: String, pid: Int32, host: String, rule: String, ai: Bool, blocked: Bool) {
        let now = Date().timeIntervalSince1970 * 1000
        queue.async {
            let key = "\(app)|\(host)"
            if let last = self.lastReport[key], now - last < 10_000 { return }
            self.lastReport[key] = now
            if self.lastReport.count > 2000 { self.lastReport.removeAll() }
            self.broadcast(["type": "flow", "ts": now, "app": app, "pid": Int(pid), "host": host, "rule": rule, "ai": ai, "blocked": blocked])
        }
    }

    private func broadcast(_ obj: [String: Any]) {
        queue.async {
            for c in self.clients.values { self.send(obj, to: c) }
        }
    }

    private func send(_ obj: [String: Any], to c: NWConnection) {
        guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        data.append(0x0A)
        c.send(content: data, completion: .contentProcessed { _ in })
    }
}
