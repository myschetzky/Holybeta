'use strict';
/*
 * Fejlfindingsflag, som HolyMoly nægter at starte med. Med fx --remote-debugging-port kan et andet program
 * styre skrivevinduet og "taste" tekst, der ligner ægte tastetryk. Fuses i package.json dækker ikke Chromium-flag.
 * Ren logik uden Electron, så den kan testes.
 */
const BAD_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'js-flags'];
const BAD_ARG = /^--(remote-debugging|inspect|js-flags)/i;
const MESSAGE = 'HolyMoly er startet med fejlfinding slået til og lukker. Start HolyMoly almindeligt.';

/** hasSwitch = (navn) => boolean (app.commandLine.hasSwitch) */
function debugFlagsUsed(argv, hasSwitch) {
  if (typeof hasSwitch === 'function' && BAD_SWITCHES.some(s => { try { return hasSwitch(s); } catch (e) { return false; } })) return true;
  return (argv || []).some(a => BAD_ARG.test(String(a)));
}

module.exports = { debugFlagsUsed, BAD_SWITCHES, MESSAGE };
