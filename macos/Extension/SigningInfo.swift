import Foundation
import Security

/// Slår programmets signatur-id op ud fra forbindelsens audit-token
/// (på macOS findes NEFilterFlow.sourceAppIdentifier ikke).
/// Caches pr. audit-token – tokenet indeholder også procesversionen, så et genbrugt
/// proces-id aldrig arver et andet programs identitet.
enum SigningInfo {
    private static let lock = NSLock()
    private static var cache: [Data: String] = [:]

    static func identifier(auditToken: Data?, pid: Int32) -> String {
        guard let token = auditToken else { return "" }
        lock.lock()
        if let hit = cache[token] { lock.unlock(); return hit }
        lock.unlock()

        let id = lookup(token)
        lock.lock()
        if cache.count > 2000 { cache.removeAll() }
        cache[token] = id
        lock.unlock()
        return id
    }

    /// Er programmet HolyMoly selv? Kun hvis det er signeret med skolens eget Team ID
    /// (signatur-id'et alene kan enhver vælge med `codesign -i`).
    static func isHolyMoly(auditToken: Data?) -> Bool {
        guard let token = auditToken, let team = teamId else { return false }
        lock.lock()
        if let hit = trusted[token] { lock.unlock(); return hit }
        lock.unlock()
        var ok = false
        let attrs = [kSecGuestAttributeAudit: token] as CFDictionary
        var code: SecCode?
        var requirement: SecRequirement?
        let req = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and (identifier \"dk.holymoly.agent\" or identifier \"dk.holymoly.filterapp\" or identifier \"dk.holymoly.filterapp.extension\" or identifier \"dk.holymoly.agent.helper\")"
        if SecCodeCopyGuestWithAttributes(nil, attrs, SecCSFlags(), &code) == errSecSuccess, let guest = code,
           SecRequirementCreateWithString(req as CFString, SecCSFlags(), &requirement) == errSecSuccess, let r = requirement {
            ok = SecCodeCheckValidity(guest, SecCSFlags(), r) == errSecSuccess
        }
        lock.lock()
        if trusted.count > 2000 { trusted.removeAll() }
        trusted[token] = ok
        lock.unlock()
        return ok
    }

    private static var trusted: [Data: Bool] = [:]

    /// Team ID'et indbygges af build.sh (HMTeamID i Info.plist). Ad hoc-bygninger har intet – så undtages ingen.
    static let teamId: String? = {
        guard let t = Bundle.main.object(forInfoDictionaryKey: "HMTeamID") as? String,
              t.count == 10, t.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil, t != "XXXXXXXXXX" else { return nil }
        return t
    }()

    private static func lookup(_ token: Data?) -> String {
        guard let token = token else { return "" }
        let attrs = [kSecGuestAttributeAudit: token] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attrs, SecCSFlags(), &code) == errSecSuccess, let guest = code else { return "" }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(guest, SecCSFlags(), &staticCode) == errSecSuccess, let sc = staticCode else { return "" }
        var info: CFDictionary?
        let flags = SecCSFlags(rawValue: UInt32(kSecCSSigningInformation))
        guard SecCodeCopySigningInformation(sc, flags, &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return "" }
        return (dict[kSecCodeInfoIdentifier as String] as? String) ?? ""
    }
}
