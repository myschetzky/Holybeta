'use strict';
/*
 * Skriveøkt hjemme: det, læreren ikke må se, bliver ikke sendt.
 * Ingen navigation, ingen programskift, ingen adresser med sti, ingen programnavne, faner eller vinduestitler.
 * Rødt kun for AI, fjernstyring og virtuelle maskiner – og kun med kategorien som tekst.
 * Serveren (hub.policyFor) håndhæver det samme. Ren logik uden Electron, så den kan testes.
 */
const HOME_ACTIVITY = 'Skriver hjemme';
const HOME_CATEGORIES = ['ai', 'remote', 'vm'];
const CATEGORY_TEXT = { ai: 'AI / chatbots', remote: 'Fjernstyring', vm: 'Virtuel maskine' };
const HOME_EVENT_KINDS = new Set(['info', 'blocked', 'violation', 'tamper', 'killed']);

function hostOnly(u) {
  try { return new URL(String(u)).hostname; } catch (e) { return ''; }
}

/** Hændelsen som den må sendes hjemme – eller null, hvis den slet ikke må sendes. */
function homeEvent(ev) {
  if (!ev || !HOME_EVENT_KINDS.has(ev.kind)) return null;
  const category = String(ev.category || '');
  const label = CATEGORY_TEXT[category];
  return {
    kind: ev.kind,
    url: ev.url ? hostOnly(ev.url) : '',
    title: label || (ev.kind === 'blocked' || ev.kind === 'violation' ? 'Blokeret' : String(ev.title || '')),
    category,
    blocked: !!ev.blocked,
  };
}

function homeViolations(list) {
  const out = [];
  for (const v of list || []) {
    if (HOME_CATEGORIES.includes(v.category) && !out.some(o => o.category === v.category)) out.push({ kind: v.kind, text: CATEGORY_TEXT[v.category], category: v.category });
  }
  return out;
}

/** Status til serveren hjemme: ingen adresse, intet program, ingen faner eller programmer. */
function homeStatus(status) {
  return {
    activity: HOME_ACTIVITY, url: '', app: '',
    violations: homeViolations(status.violations),
    degraded: status.degraded || [],
    ext: status.ext || null,
    screens: status.screens || 1,
  };
}

module.exports = { homeEvent, homeStatus, homeViolations, hostOnly, HOME_ACTIVITY, HOME_CATEGORIES, CATEGORY_TEXT };
