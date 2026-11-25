// HolyMoly Filter.app – installerer og slår netværksfilteret til.
// Køres af HolyMoly-appen:  "HolyMoly Filter.app/Contents/MacOS/HolyMoly Filter" activate|status|deactivate
// Svarer med én JSON-linje pr. hændelse på stdout.
import Foundation
import NetworkExtension
import SystemExtensions

let extensionId = "dk.holymoly.filterapp.extension"

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

func finish(_ ok: Bool, _ obj: [String: Any]) -> Never {
    var o = obj
    o["ok"] = ok
    o["done"] = true
    emit(o)
    exit(ok ? 0 : 1)
}

/// Slår indholdsfilteret til i Systemindstillinger -> Netværk -> Filtre.
func enableFilter(_ completion: @escaping (Error?) -> Void) {
    let manager = NEFilterManager.shared()
    manager.loadFromPreferences { error in
        if let error = error { return completion(error) }
        let config = NEFilterProviderConfiguration()
        config.filterSockets = true
        config.filterPackets = false
        config.organization = "HolyMoly"
        config.filterDataProviderBundleIdentifier = extensionId
        manager.providerConfiguration = config
        manager.localizedDescription = "HolyMoly"
        manager.isEnabled = true
        manager.saveToPreferences { completion($0) }
    }
}

final class Delegate: NSObject, OSSystemExtensionRequestDelegate {
    let activating: Bool
    init(activating: Bool) { self.activating = activating }

    func request(_ request: OSSystemExtensionRequest,
                 actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        return .replace // opdater til den nye version
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        // Eleven skal godkende i Systemindstillinger -> Anonymitet og sikkerhed
        emit(["status": "needs_approval"])
    }

    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        let reboot = (result == .willCompleteAfterReboot)
        guard activating else { finish(true, ["status": "deactivated", "reboot": reboot]) }
        enableFilter { error in
            if let error = error { finish(false, ["status": "filter_config_failed", "error": error.localizedDescription]) }
            finish(true, ["status": "enabled", "reboot": reboot])
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        let ns = error as NSError
        var o: [String: Any] = ["status": "failed", "error": ns.localizedDescription, "code": ns.code, "domain": ns.domain]
        if ns.domain == OSSystemExtensionErrorDomain {
            // Appen skal ligge i /Programmer – HolyMoly kopierer den dertil og prøver igen
            o["parentLocation"] = (ns.code == OSSystemExtensionError.Code.unsupportedParentBundleLocation.rawValue)
        }
        finish(false, o)
    }
}

let args = CommandLine.arguments.dropFirst()
let command = args.first ?? "status"
var delegate: Delegate?

switch command {
case "activate":
    delegate = Delegate(activating: true)
    let req = OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: extensionId, queue: .main)
    req.delegate = delegate
    OSSystemExtensionManager.shared.submitRequest(req)
    // Eleven kan være længe om at godkende – giv op efter 15 minutter
    DispatchQueue.main.asyncAfter(deadline: .now() + 900) { finish(false, ["status": "timeout"]) }
case "deactivate":
    delegate = Delegate(activating: false)
    NEFilterManager.shared().loadFromPreferences { _ in
        NEFilterManager.shared().removeFromPreferences { _ in
            let req = OSSystemExtensionRequest.deactivationRequest(forExtensionWithIdentifier: extensionId, queue: .main)
            req.delegate = delegate
            OSSystemExtensionManager.shared.submitRequest(req)
        }
    }
case "status":
    NEFilterManager.shared().loadFromPreferences { error in
        let m = NEFilterManager.shared()
        finish(error == nil, [
            "status": "status",
            "configured": m.providerConfiguration != nil,
            "enabled": m.isEnabled,
            "error": error?.localizedDescription ?? "",
        ])
    }
default:
    finish(false, ["status": "unknown_command"])
}

dispatchMain()
