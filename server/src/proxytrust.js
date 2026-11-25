'use strict';
/*
 * TRUST_PROXY: hvilke afsendere må sætte X-Forwarded-For, -Proto og -Host.
 *
 * Værdien er en liste (komma eller mellemrum) af IP-adresser, net (CIDR, fx 172.16.0.0/12) og værtsnavne
 * (fx "caddy" eller "cloudflared" i docker compose). Værtsnavne slås op ved start og igen hvert minut,
 * fordi en container kan få en ny adresse, når den genstartes.
 * Headerne bruges kun, når forbindelsen kommer fra en af dem (req.socket.remoteAddress).
 *
 * "1" (eller true) stoler på alle afsendere, som før. Det er kun sikkert, hvis ingen kan nå serveren uden om
 * proxyen – ellers kan enhver skrive en falsk IP-adresse og slippe uden om grænserne for login-forsøg.
 */
const net = require('node:net');
const dns = require('node:dns');

const REFRESH_MS = 60_000;

/** "::ffff:10.0.0.1" -> "10.0.0.1" */
function plainIp(a) {
  const s = String(a || '').trim();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s;
}

function parseList(value) {
  return String(value ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

/**
 * value: TRUST_PROXY-værdien (tekst eller true/false). Returnerer { all, none, entries, trusts(addr), refresh(), stop() }.
 * opts.lookup kan erstatte dns.lookup (tests).
 */
function createProxyTrust(value, opts = {}) {
  const log = opts.log || (() => {});
  const lookup = opts.lookup || ((host) => dns.promises.lookup(host, { all: true }));
  const v = value === true ? '1' : value === false || value == null ? '' : String(value).trim();
  const all = v === '1' || v.toLowerCase() === 'true';
  const entries = all || v === '0' ? [] : parseList(v);
  const none = !all && !entries.length;
  const fixed = new net.BlockList();
  const hosts = [];
  for (const e of entries) {
    const [addr, bits] = e.split('/');
    const type = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null;
    if (type && bits !== undefined) {
      const n = Number(bits);
      if (Number.isInteger(n) && n >= 0 && n <= (type === 'ipv4' ? 32 : 128)) fixed.addSubnet(addr, n, type);
      else log(`ADVARSEL: TRUST_PROXY har et ugyldigt net: ${e}`);
    } else if (type) fixed.addAddress(addr, type);
    else if (/^[a-z0-9.-]{1,253}$/i.test(e)) hosts.push(e.toLowerCase());
    else log(`ADVARSEL: TRUST_PROXY har en ugyldig værdi: ${e}`);
  }
  let resolved = new Set(); // IP-adresser for værtsnavnene
  let timer = null;

  async function refresh() {
    if (!hosts.length) return;
    const next = new Set();
    await Promise.all(hosts.map(async (h) => {
      try { for (const r of await lookup(h)) next.add(plainIp(r.address)); } catch (e) { /* værten findes ikke (endnu) */ }
    }));
    resolved = next;
  }
  if (hosts.length) {
    timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
    if (timer.unref) timer.unref();
  }
  const ready = refresh().catch(() => {});

  function trusts(remoteAddress) {
    if (all) return true;
    if (none) return false;
    const ip = plainIp(remoteAddress);
    const type = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
    if (!type) return false;
    return fixed.check(ip, type) || resolved.has(ip);
  }
  return {
    all, none, entries, ready, trusts, refresh,
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createProxyTrust, plainIp };
