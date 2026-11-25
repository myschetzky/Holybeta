import Foundation

/// Filterets tilstand. Uforanderlig – en ny instans laves ved hver ændring,
/// så den trygt kan læses fra mange tråde samtidig.
final class FilterState {
    let active: Bool
    let until: Double          // ms siden 1970 – filteret slår selv fra herefter
    let ai: HostMatcher        // AI-tjenester: blokeres og meldes
    let block: HostMatcher     // andre forbudte domæner: blokeres
    let dropAi: Bool
    /// Fingeraftryk af reglerne – enhver ændring (ikke kun antal) kan ses
    let fingerprint: String

    init(active: Bool = false, until: Double = 0, ai: [String] = [], block: [String] = [], dropAi: Bool = true) {
        self.active = active
        self.until = until
        self.ai = HostMatcher(Baseline.ai + ai)
        self.block = HostMatcher(block)
        self.dropAi = dropAi
        self.fingerprint = FilterState.hash([active ? "1" : "0", String(Int(until)), dropAi ? "1" : "0"] + ai.sorted() + ["|"] + block.sorted())
    }

    private static func hash(_ parts: [String]) -> String {
        // FNV-1a 64 bit – rigeligt til at opdage ændringer (ikke en sikkerhedsnøgle)
        var h: UInt64 = 0xcbf29ce484222325
        for p in parts { for b in p.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }; h ^= 0x0A; h = h &* 0x100000001b3 }
        return String(h, radix: 16)
    }

    var isLive: Bool { active && until > Date().timeIntervalSince1970 * 1000 }


}
