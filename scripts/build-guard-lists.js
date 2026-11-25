#!/usr/bin/env node
/*
 * Laver vagtens indbyggede basisliste (agent/guard/baseline-hosts.txt) ud fra shared/rules.js.
 * Listen gælder ALTID under en lektion og ligger i programmappen (kun administrator kan ændre den),
 * så en elev ikke kan "tømme" lektionens blokeringsliste.
 * Kun AI-tjenester – dem tillader ingen lærer normalt; resten kommer fra klassens regler.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = require('../shared/rules.js');
const { expandHosts } = require('../agent/src/guard.js');

const data = R.RULE_DATA;
// Kun de centrale AI-chatbots + AI-API'er (ikke fx Replit/Cursor, som en programmeringslærer kan tillade)
const CORE = ['chatgpt.com', 'chat.com', 'openai.com', 'oaiusercontent.com', 'claude.ai', 'anthropic.com',
  'perplexity.ai', 'grok.com', 'x.ai', 'gemini.google.com', 'bard.google.com', 'aistudio.google.com',
  'copilot.microsoft.com', 'deepseek.com', 'chat.mistral.ai', 'poe.com', 'character.ai', 'you.com',
  'phind.com', 'meta.ai', 'pi.ai', 'quillbot.com', 'duck.ai', 'chat.qwen.ai', 'kimi.com', 'z.ai'];
const ai = CORE.concat(data.aiEndpoints).filter(d => !d.includes('/'));
const hosts = expandHosts(ai);
const out = path.join(__dirname, '..', 'agent', 'guard', 'baseline-hosts.txt');
fs.writeFileSync(out, '# Genereret af scripts/build-guard-lists.js – ret i shared/rules.js\n' + hosts.join('\n') + '\n');
console.log('✓', path.relative(path.join(__dirname, '..'), out), `(${hosts.length} værtsnavne)`);

// Tvangsinstallation af browser-delen (fra agent/config.json)
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agent', 'config.json'), 'utf8'));
const fi = cfg.forceInstall || {};
const ext = { chrome: String(fi.chrome || ''), edge: String(fi.edge || ''), firefox: String(fi.firefox || '') };
fs.writeFileSync(path.join(__dirname, '..', 'agent', 'guard', 'extensions.json'), JSON.stringify(ext, null, 2) + '\n');
console.log('✓ agent/guard/extensions.json');

// Vagtens egen konfiguration: serverens adresse og (valgfrit) udgiver/Team ID til at genkende den ægte app
const guardCfg = { serverUrl: String(cfg.serverUrl || ''), publisher: String(cfg.publisher || ''), teamId: String(cfg.teamId || '') };
fs.writeFileSync(path.join(__dirname, '..', 'agent', 'guard', 'config.json'), JSON.stringify(guardCfg, null, 2) + '\n');
console.log('✓ agent/guard/config.json');
