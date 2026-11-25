'use strict';
/*
 * Netværksovervågning: hvilke programmer har en åben forbindelse til en AI-tjeneste?
 *
 * Windows giver os (program, IP) for hver forbindelse og en DNS-cache (værtsnavn -> IP).
 * Vi kobler dem – og for at undgå falske positiver tæller en IP kun som AI, hvis ALLE
 * værtsnavne der peger på den er AI-tjenester. Delte CDN-adresser (fx Cloudflare, der både
 * bærer chatgpt.com og tusindvis af almindelige sider) giver derfor aldrig rød.
 *
 * Ingen betalte API'er, ingen data sendes ud – det hele sker lokalt på elevens computer.
 */

/**
 * @param net   { conns: [[pid, ip, port]], dns: [[name, ip]] }
 * @param R     kompileret ACRules
 * @returns     [{ pid, ip, host }] – kun entydige AI-forbindelser
 */
function aiConnections(net, R) {
  if (!net || !Array.isArray(net.conns) || !Array.isArray(net.dns)) return [];
  const ipNames = new Map();
  for (const pair of net.dns) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const name = String(pair[0] || '').toLowerCase().replace(/\.$/, '');
    const ip = String(pair[1] || '').toLowerCase();
    if (!name || !ip) continue;
    if (!ipNames.has(ip)) ipNames.set(ip, new Set());
    ipNames.get(ip).add(name);
  }
  const out = [];
  const seen = new Set();
  for (const c of net.conns) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const pid = Number(c[0]) || 0;
    const ip = String(c[1] || '').toLowerCase().replace(/^::ffff:/, '');
    const names = ipNames.get(ip);
    if (!pid || !names || !names.size) continue;
    const all = [...names];
    const ai = all.filter(n => R.isAiHost(n));
    if (!ai.length || ai.length !== all.length) continue; // tvetydig adresse -> ignorer
    const key = pid + '|' + ai[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid, ip, host: ai[0] });
  }
  return out;
}

module.exports = { aiConnections };
