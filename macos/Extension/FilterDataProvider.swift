import Foundation
import NetworkExtension
import os.log

/// Ser hver ny netværksforbindelse på Mac'en: hvilket program, hvilket værtsnavn.
/// Under en lektion blokeres AI-tjenester og forbudte sider for ALLE programmer
/// (Safari, Word, Pages, Python, ukendte apps …), og AI-forbindelser meldes til HolyMoly.
/// Uden for en lektion lukkes alt igennem, og intet registreres.
final class FilterDataProvider: NEFilterDataProvider {
    private let log = OSLog(subsystem: "dk.holymoly.filterapp.extension", category: "filter")

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        // Alle nye forbindelser sendes til handleNewFlow
        let settings = NEFilterSettings(rules: [], defaultAction: .filterData)
        apply(settings) { error in
            if let error = error {
                os_log("Kunne ikke starte filter: %{public}@", log: self.log, type: .error, error.localizedDescription)
            } else {
                ControlServer.shared.start()
            }
            completionHandler(error)
        }
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        ControlServer.shared.stop()
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        let state = ControlServer.shared.state
        guard state.isLive else { return .allow() }
        guard let socketFlow = flow as? NEFilterSocketFlow else { return .allow() }

        // Værtsnavnet findes når programmet forbinder via navn (URLSession/Network.framework –
        // det gør Safari, Word, Pages, de fleste apps og scripts).
        var host = socketFlow.remoteHostname ?? ""
        if host.isEmpty, let h = flow.url?.host { host = h }
        if host.isEmpty { return .allow() }

        let aiMatch = state.ai.match(host)
        let blockMatch = aiMatch == nil ? state.block.match(host) : nil
        if aiMatch == nil && blockMatch == nil { return .allow() } // langt de fleste forbindelser

        // Hvilket program? (signatur-id, fx "com.microsoft.Word") – kun slået op for forbudte værtsnavne
        let pid = FilterDataProvider.pid(from: flow.sourceAppAuditToken)
        if SigningInfo.isHolyMoly(auditToken: flow.sourceAppAuditToken) { return .allow() }
        let signingId = SigningInfo.identifier(auditToken: flow.sourceAppAuditToken, pid: pid)

        if let matched = aiMatch {
            ControlServer.shared.report(app: signingId, pid: pid, host: host, rule: matched, ai: true, blocked: state.dropAi)
            return state.dropAi ? .drop() : .allow()
        }
        if let matched = blockMatch {
            ControlServer.shared.report(app: signingId, pid: pid, host: host, rule: matched, ai: false, blocked: true)
            return .drop()
        }
        return .allow()
    }

    /// audit_token_t er 8 × UInt32; nr. 5 er proces-id'et.
    static func pid(from token: Data?) -> Int32 {
        guard let token = token, token.count >= 32 else { return 0 }
        return token.withUnsafeBytes { raw in
            Int32(bitPattern: raw.load(fromByteOffset: 20, as: UInt32.self))
        }
    }
}
