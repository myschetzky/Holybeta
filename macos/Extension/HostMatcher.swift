import Foundation

/// Matcher et værtsnavn mod en liste af domæner – inkl. underdomæner
/// ("chatgpt.com" matcher også "ab.chatgpt.com", men ikke "notchatgpt.com").
final class HostMatcher {
    private let domains: Set<String>

    init(_ list: [String]) {
        var set = Set<String>()
        for raw in list {
            var d = raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            if d.hasPrefix("*.") { d.removeFirst(2) }
            if d.isEmpty || d.contains("/") || d.contains(" ") || d.count > 253 { continue }
            set.insert(d)
        }
        domains = set
    }

    var count: Int { domains.count }

    func match(_ host: String) -> String? {
        var h = host.lowercased()
        if h.hasSuffix(".") { h.removeLast() }
        if h.isEmpty || domains.isEmpty { return nil }
        var labels = h.split(separator: ".").map(String.init)
        while !labels.isEmpty {
            let candidate = labels.joined(separator: ".")
            if domains.contains(candidate) { return candidate }
            labels.removeFirst()
        }
        return nil
    }
}

/// Indbygget minimumsliste over AI-tjenester. Gælder altid under en lektion,
/// så en falsk "config" fra et andet program ikke kan gøre filteret svagere.
enum Baseline {
    static let ai: [String] = [
        "openai.com", "chatgpt.com", "chat.com", "oaiusercontent.com", "anthropic.com", "claude.ai",
        "perplexity.ai", "grok.com", "x.ai", "gemini.google.com", "bard.google.com", "aistudio.google.com",
        "notebooklm.google.com", "generativelanguage.googleapis.com", "aiplatform.googleapis.com",
        "copilot.microsoft.com", "copilot.cloud.microsoft", "sydney.bing.com", "openai.azure.com",
        "deepseek.com", "mistral.ai", "poe.com", "character.ai", "you.com", "phind.com", "meta.ai",
        "huggingface.co", "openrouter.ai", "groq.com", "together.xyz", "together.ai", "api.cohere.ai",
        "api.cohere.com", "quillbot.com", "kimi.com", "chat.qwen.ai", "githubcopilot.com",
        "copilot-proxy.githubusercontent.com", "codeium.com", "cursor.sh", "duck.ai",
    ]
}
