'use strict';
/*
 * Blokliste for adgangskoder (NIST SP 800-63B-4, afsnit 3.1.1.2): nye adgangskoder tjekkes mod
 * almindelige og lækkede adgangskoder og mod ord fra konteksten (tjenestens navn, brugerens e-mail og navn).
 * Ingen regler om store bogstaver/tal/tegn – de gør kun adgangskoder sværere at huske (NIST forbyder dem).
 *
 * Listen er kort og ligger i koden (ingen netværksopslag med lærerens adgangskode). Den fanger de
 * adgangskoder, der prøves først i et angreb: de mest brugte i verden og på dansk, også med tal/år/tegn efter.
 */

// Almindelige ord/adgangskoder – sammenlignes med hele adgangskoden og med den uden tal/tegn foran og bagved.
const BASE = `
password passw0rd passord passwort contraseña motdepasse wachtwoord salasana haslo parola
kodeord adgangskode adgangskoden hemmelig hemmeligt hemmelighed kode koden minkode mitkodeord
qwerty qwertz azerty asdf asdfgh asdfghjkl zxcvbn zxcvbnm qazwsx qweasd 1q2w3e4r qwertyuiop
abc abcd abcdef abcdefg abcdefgh abc123 letmein welcome velkommen hello hej hejsa hejmeddig
admin administrator root login logind user bruger test tester testing guest gæst default standard
iloveyou jegelskerdig elskerdig kærlighed love lovely sunshine princess prinsesse dragon monkey abe
football fodbold soccer baseball basketball hockey håndbold handbold superman batman pokemon minecraft
master shadow trustno1 freedom whatever qwerty123 starwars computer internet secret
sommer vinter forår foraar efterår efteraar januar februar marts april maj juni juli august september oktober november december
mandag tirsdag onsdag torsdag fredag lørdag søndag
danmark denmark kobenhavn københavn copenhagen aarhus århus odense aalborg esbjerg randers kolding horsens vejle roskilde
skole skolen gymnasium gymnasiet lærer laerer teacher elev elever student klasse klassen undervisning dansk matematik
fck brondby brøndby agf aab ob fcm fcn
hund hunden kat katten hest hesten fisk fugl bamse bamsen mor far mormor morfar farmor farfar
lego carlsberg tuborg vestas maersk mærsk novo
holymoly holy moly
`.trim().split(/\s+/);

// Hele adgangskoder, der er almindelige, men ikke fanges af reglerne nedenfor
const WHOLE = `
123456789 1234567890 12345678910 0123456789 987654321 9876543210 1111111111 0000000000 1234512345
123123123 123321123 147258369 159753159 qwerty12345 password123 password1234 kodeord123 kodeord1234
iloveyou123 abcd123456 a123456789 q1w2e3r4t5 1q2w3e4r5t zaq12wsx 1qaz2wsx3edc qazwsxedc
`.trim().split(/\s+/);

const BASE_SET = new Set(BASE);
const WHOLE_SET = new Set(WHOLE);
const ROWS = ['qwertyuiopå', 'asdfghjklæø', 'zxcvbnm', 'qwertzuiop', 'azertyuiop', 'abcdefghijklmnopqrstuvwxyzæøå', '01234567890', '1234567890'];

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();
/** Fjern tal, mellemrum og tegn foran og bagved: "Sommer2024!" -> "sommer". */
const core = (s) => s.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
/** Kun bogstaver og tal (også æøå), ingen tegn: "holy.moly-1" -> "holymoly1". */
const letters = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '');

/** Gentagelser og rækker på tastaturet / i alfabetet: "aaaaaaaaaa", "abababab", "1234567890", "qwertyuiop". */
function trivial(pw) {
  if (pw.length < 3) return true;
  if (/^(.{1,3})\1+.?$/u.test(pw)) return true;
  const rev = [...pw].reverse().join('');
  for (const row of ROWS) {
    if (row.includes(pw) || row.includes(rev)) return true;
  }
  return false;
}

/** Ord fra konteksten: e-mailens navn-del, brugerens navn og tjenesten. */
function contextWords(ctx = {}) {
  const words = new Set(['holymoly']);
  const add = (s) => {
    const t = norm(s);
    if (letters(t).length >= 4) words.add(letters(t));
    for (const w of t.split(/[^\p{L}\p{N}]+/u)) if (letters(w).length >= 4) words.add(letters(w));
  };
  const [local = '', domain = ''] = norm(ctx.email).split('@');
  add(local);
  add(domain.split('.').slice(0, -1).join(' ')); // "aarhus-gym.dk" -> aarhus, aarhusgym
  add(ctx.name);
  add(ctx.school);
  return words;
}

/**
 * Returnerer en fejltekst til brugeren, eller null hvis adgangskoden er i orden.
 * @param {string} pw
 * @param {{email?:string,name?:string,school?:string}} [ctx]
 */
function weakReason(pw, ctx) {
  const p = norm(pw);
  if (WHOLE_SET.has(p) || BASE_SET.has(p)) return 'Adgangskoden er en af de mest brugte – vælg en anden';
  const c = core(p);
  if (BASE_SET.has(c) || BASE_SET.has(letters(c))) return 'Adgangskoden er et almindeligt ord med tal eller tegn – vælg noget sværere at gætte, fx tre-fire tilfældige ord';
  if (trivial(p) || (letters(p) !== p && trivial(letters(p)))) return 'Adgangskoden er en række eller gentagelse – vælg noget sværere at gætte';
  // Bygget af lærerens egne ord (navn, e-mail, skole, "HolyMoly") + tal/tegn: "mette-mette", "holymoly.mette2024"
  let rest = letters(p);
  for (const w of [...contextWords(ctx)].sort((a, b) => b.length - a.length)) rest = rest.split(w).join('');
  if (letters(p).length && rest.replace(/\p{N}+/gu, '').length < 3) return 'Adgangskoden må ikke bare være dit navn, din e-mail, skolen eller "HolyMoly"';
  return null;
}

module.exports = { weakReason };
