// Simuleret elev-app til vagt-testene: forbinder med elevens token og sender grøn status.
// Køres fra installationsmappens "HolyMoly"-binærfil, så vagten ser den som den ægte app.
'use strict';
const path = require('node:path');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '../../server')] }));
const fs = require('node:fs');
const [token, osName, guardData] = process.argv.slice(2);
const ws = new WebSocket('ws://127.0.0.1:18080/ws/agent');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', tokens: [token], device: { os: osName, host: 'CI', version: '1.3.0' } }));
  setInterval(() => ws.send(JSON.stringify({ type: 'status', activity: 'docs.google.com – Dansk', violations: [], degraded: [] })), 1000);
});
// Som den rigtige app: parringskoden fra serveren afleveres til vagten (requests/pair.txt)
ws.on('message', (d, bin) => {
  if (bin) return;
  const m = JSON.parse(d.toString());
  if (m.type === 'welcome' && m.guardPair) {
    const lines = Object.entries(m.guardPair).map(([sid, code]) => `pair=${sid}\t${code}`);
    if (lines.length) {
      fs.mkdirSync(path.join(guardData, 'requests'), { recursive: true });
      fs.writeFileSync(path.join(guardData, 'requests', 'pair.txt'), lines.join('\n') + '\n');
    }
  }
});
ws.on('close', () => process.exit(0));
