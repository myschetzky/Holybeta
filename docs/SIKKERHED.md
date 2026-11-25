# Sikkerhed i HolyMoly

HolyMoly behandler oplysninger om børn og unge (hvad eleven laver på computeren i timen, skærmbilleder, elevens tekster)
og lærernes login. Dette dokument samler, hvad der er gjort for at beskytte det, hvad det bygger på, og hvad der mangler.
Det opdateres løbende – se `git log -- docs/SIKKERHED.md`.

## Det bygger på

| Kilde | Hvad vi bruger den til |
|---|---|
| [OWASP Top 10:2025](https://owasp.org/Top10/2025/0x00_2025-Introduction/) | De ti største risici for webapplikationer. Nyt i 2025: A03 *Software Supply Chain Failures* og A10 *Mishandling of Exceptional Conditions*; *Security Misconfiguration* er rykket op som nr. 2. |
| [OWASP HTTP Headers Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html) og [MDN om CORP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cross-origin_resource_policy) | Sikkerheds-headers og Content-Security-Policy |
| [NIST SP 800-63B-4](https://csrc.nist.gov/pubs/sp/800/63/B/4/final) (juli 2025) | Adgangskoder (længde frem for tegn-krav, blokliste over almindelige/lækkede adgangskoder) og sessioner (genlogin mindst hver 24. time ved AAL2) |
| [UVM: notat om dataansvar og monitorering](https://uvm.dk/-/media/filer/uvm/udd/gym/pdf19/maj/190507-notat-om-dataansvar-og-monitorering.pdf?la=da) | Skolen er dataansvarlig, HolyMoly er databehandler; databehandleraftale efter art. 28, stk. 3 |
| [Datatilsynets tjekliste til skoler](https://www.Datatilsynet.dk/Media/638091909929979891/Tjekliste_skoler.pdf) og [UVM/KL's dataetiske principper](https://uvm.dk/-/media/filer/uvm/aktuelt/pdf18/180927-dataetiske-principper-uvm-og-kl.pdf) | Data om elever må kun indsamles, når det er sagligt, relevant og nødvendigt |

## Hvad der er på plads

**Adgang (OWASP A01)**
- Lærere ser kun egne klasser; alle adresser med id'er tjekker ejerskab (tests: `server.test.js` "adgang og validering").
- Forespørgsler, der ændrer noget, skal komme fra samme oprindelse (`Origin`), og websockets til dashboardet kræver login og samme oprindelse.
- Elev-appen er bundet til computeren af HolyMoly-vagten (SYSTEM/root) med nøglepar; elevens kode kan ikke bruges fra en anden computer.

**Konfiguration og headers (A02)**
- `Content-Security-Policy`: kun egne scripts og styles; websockets **kun til serveren selv** (bygges pr. forespørgsel med det tjekkede værtsnavn); `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`; `upgrade-insecure-requests` på https.
- `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy` (ingen kamera, mikrofon, placering, betaling, USB).
- Cookies: `HttpOnly`, `SameSite=Strict` (lærer), `Secure` på https. Kun hashen af session-tokenet gemmes.
- Links i mails peger altid på `PUBLIC_URL` – aldrig på `Host`-headeren.

**Forsyningskæden (A03)**
- Alle GitHub Actions er låst til commit-SHA'er; mindst mulige rettigheder (`contents: read`), kun udgivelses-jobbet må skrive.
- `npm audit` (høj/kritisk) for serveren og elev-appen ved hvert push; Dependabot foreslår opdateringer hver uge.
- Ingen byggeværktøjer i det, der kører hos skolen (`--omit=dev`).

**Kryptografi (A04)**
- Adgangskoder hashes med scrypt i OWASP's anbefalede styrke (N=2^14, r=8, p=5 ≈ N=2^17, p=1, men med 16 MiB i stedet for 128 MiB). Parametrene står i hashen; ældre, svagere hashes opgraderes automatisk ved lærerens næste login.
- To-faktor-hemmeligheder krypteres i databasen; skrive-beviser signeres med Ed25519.
- Signeringsnøglen ligger aldrig i klartekst i `backup/`. Den kommer kun ud af serveren krypteret (AES-256-GCM, scrypt-afledt nøgle fra `BACKUP_PASSPHRASE`) med `enkel -- backup-ud`, og `enkel -- gendan-test` tjekker gendannelsen. Nøgleringen `trusted_keys` holder gamle offentlige nøgler, så gamle beviser kan verificeres efter et nøgleskifte (`enkel -- ny-noegle`); gamle nøgler kan aldrig signere. Se docs/PROXMOX.md.

**Injektion (A05)**
- Al SQL er parametriseret; CSV-eksport beskytter mod formel-injektion; dashboardet bygger HTML uden `innerHTML` med elevdata.

**Login (A07)**
- Mindst 10 tegn, op til 200, ingen tegn-krav. **Blokliste** (`server/src/passwords.js`): de mest brugte adgangskoder (også danske), almindelige ord med tal/år/tegn (`Sommer2024!`), rækker og gentagelser, og lærerens eget navn, e-mail, skole og "HolyMoly".
- To-faktor (godkendelses-app eller UNI-Login), reservekoder, rate-limit pr. IP og pr. konto, samme svartid uanset om kontoen findes.
- Sessioner udløber efter 12 timer uden aktivitet og **senest 12 timer efter login** uanset aktivitet (`SESSION_MAX_HOURS`, højst 24) – en stjålet cookie kan ikke holdes i live.
- Ny adgangskode eller nulstilling logger ud alle andre steder.

**Logning og alarmer (A09)**
- Læreren får en mail, når adgangskoden ændres eller nulstilles, når to-faktor slås til/fra, når der laves nye reservekoder, og når nogen gentagne gange taster forkert to-faktor-kode efter rigtig adgangskode.
- Lærerens handlinger over for en elev (frys, live-skærm, skærmbillede, eksport) står i elevens logbog.
- **Sikkerhedslog til skolens administrator** (Skole → Sikkerhedslog, `GET /api/school/security-log`): logins med metode (adgangskode, to-faktor, reservekode, Unilogin), forkert adgangskode og forkert to-faktor-kode for kendte konti, ændringer af adgangskode og to-faktor, invitationer, roller, fjernede lærere, nulstillet to-faktor, skolens navn og institutionsnummer. Med IP-adresse; gemmes i 90 dage. Ukendte e-mails logges ikke.

**Fejl (A10)**
- Uventede fejl giver "Serverfejl" uden detaljer; detaljerne skrives kun i serverens log. Ugyldige cookies/adresser kan ikke få serveren til at gå ned (regressionstest).
- En glemt fejl i et løfte logges, og serveren kører videre. En ægte undtagelse stopper processen, og den startes igen af Docker (`restart: unless-stopped`) eller af "Start HolyMoly.cmd" (højst 20 gange).
- Serveren henter aldrig adresser, som en bruger har skrevet (ingen SSRF); den eneste udgående forbindelse er til UNI-Login, hvis adresse står i serverens opsætning.

**GDPR**
- Ingen keylogger: HolyMoly ser aldrig, hvad eleven taster i andre programmer. I HolyMolys eget skrivevindue (og i Word gennem HolyMoly, kun mens Word-dokumentet er fremme – se docs/WORD.md) tælles skrivestatistik til mærket "✓ Tastet i HolyMoly – intet indsat" (antal anslag, tempo og rytme, forsøg på at indsætte, tid uden for vinduet) – ikke hvilke taster. Skriverytme ligger tæt på biometri og bør nævnes i skolens DPIA.
- Overvågning kun i lektionen/skriveøkten. Overvågningsdata – hændelser, skærmbilleder og lampernes tidslinje – slettes automatisk efter `LOG_RETENTION_DAYS` (standard 30). Sletter man en elev eller klasse, slettes alt om den.
- Ved ophør (licens-servere): skolens data slettes automatisk 90 dage efter, at prøveperiode og licens er udløbet; administratorerne varsles 30 og 7 dage før. Bestillinger bevares som fakturagrundlag (bogføringsloven) uden kobling til skolen.
- Se `docs/JURA.md` for skolens del: databehandleraftale, DPIA og information til elever og forældre.

**Skrive-beviset: grænserne er offentlige**
- Grænserne står i koden (`shared/doc.js` `PROOF` og `server/src/docs.js`). At skjule dem her ville være teater. Eleven ser stadig kun kategorier og aldrig sine egne tal.
- Elevens egne tal: mindst 100 ord, højst 15 tegn/sek. over 5 sek., højst 30 tegn inden for ét sekund, højst 25 % tastetryk hurtigere end 12 ms (fra 200 tastetryk), jævnhed (variationskoefficient) mindst 0,25 (fra 300 tastetryk) og højst 10 % dikteret tekst.
- Serverens egne tjek: teksten må ikke vokse mere end 15 tegn/sek. mellem to gemninger, gennemsnittet over hele skrivetiden højst 10 tegn/sek. (over 600 tegn), et nyt dokument højst 150 tegn første gang, højst 10 % eller 3 min. grå tid, mens teksten voksede, og højst 15 % eller 10 min. grå tid uden vækst.
- Rød lampe koster kun mærket ved AI, fjernstyring, virtuel maskine, proxy/VPN og rød uden kategori (fx en vagt-advarsel). Anden rød (video, spil, sociale medier …) er en note til læreren.
- Hjælpemidler (`students.aids`: ordforslag, diktering) sættes af læreren i elevskuffen ("Hjælpemidler" ved "+ tid"), står i revisionssporet, vises for eleven i skrivevinduet og udløber ved skoleårets slutning (`aids_until`). Med diktering bliver byger, hurtige tastetryk og jævnhed til noter; med ordforslag kun byger, så autotyper-tjekket (jævnhed, hurtige tastetryk, taster fra et program) stadig gælder, og beviset har den samme neutrale tempolinje som for alle andre ("Intet skrevet hurtigere, end et menneske kan"). Kun lærerens egen visning siger "Skrivetempo ikke vurderet". Serverens eget vækst-tjek gælder stadig. Listen over hjælpemidler står aldrig i beviset, mærket eller Word-filen.
- Øvedokumentet i skrivevinduet ligger kun i vinduets hukommelse og sendes aldrig. Det vurderes lokalt med de samme regler (`evaluateStats`) – derfor er grænserne ikke en hemmelighed.

## Ændringer i sikkerhedsrunden 2026-11-24

| # | Hvad | Hvorfor | Test |
|---|---|---|---|
| 1 | CSP: websockets kun til serveren selv; `object-src 'none'`; CORP | `ws: wss:` tillod websockets til enhver vært – en vej ud for elevdata efter en evt. XSS | `server.test.js` (headers, falsk Host) + e2e i rigtig browser |
| 2 | Blokliste for adgangskoder | NIST 800-63B-4 kræver det | `passwords.test.js`, `accounts.test.js` |
| 3 | Actions låst til SHA'er, mindst mulige rettigheder, `npm audit`, Dependabot | OWASP A03; et flyttet tag på en action med skriveadgang kunne udgive falske installationsfiler | CI |
| 4 | Absolut levetid for lærerens session | Serveren forlængede sessionen uden grænse | `server.test.js` |
| 5 | Mail ved ændring af adgangskode og to-faktor | OWASP ASVS; en overtagelse opdages med det samme | `accounts.test.js` |
| 6 | Lampernes tidslinje slettes efter opbevaringsfristen | Blev gemt for evigt (GDPR art. 5) | `server.test.js` |
| 7 | scrypt fra p=1 til p=5 (OWASP-niveau), parametre i hashen, opgradering ved login | N=2^14, r=8, p=1 var under OWASP's minimum | `passwords.test.js` |
| 8 | Glemte fejl i løfter logges i stedet for at vælte serveren; den bærbare Windows-server genstarter selv efter et nedbrud | OWASP A10: ét nedbrud midt i en lektion gør alle elever grå | `server.test.js` (rigtig proces) |
| 9 | Automatisk sletning efter ophør: 90 dage efter, at prøveperiode og licens er udløbet (`PURGE_AFTER_DAYS`), varsel 30 og 7 dage før, aldrig uden mindst 7 dages varsel; bestillinger bevares | Databehandleraftalen og `/sikkerhed` lover det (GDPR art. 28, stk. 3, litra g) | `purge.test.js` |
| 10 | `/.well-known/security.txt` (RFC 9116) | Forskere skal kunne finde, hvor sikkerhedsfejl meldes (CISA/CFCS) | `server.test.js` |
| 11 | Sikkerhedslog til skolens administrator | OWASP A09: skolen skal kunne se logins og ændringer, ikke kun HolyMoly | `seclog.test.js` |
| 12 | Udvidelsesadresser vises aldrig som aktivitet hos læreren (også før siden har fået titel) – titlen bruges ikke som adresse | Fundet af e2e i CI | `policy.test.js` |
| 13 | Login-siden viser aldrig tekst fra adressen (Unilogin-fejl sendes i en kortlivet cookie) | Indholds-forfalskning: et ægte HolyMoly-link med en falsk besked ("ring til …") | `unilogin.test.js` |
| 14 | Elev-appen: ingen navigation, nye vinduer, `<webview>` eller tilladelser i nogen af appens vinduer | Den frosne skærm manglede navigationslåsen – en fil trukket ind på den kunne vises i fuld skærm | e2e (frosset skærm) |
| 15 | Docker: `/data` ejes af brugeren i billedet; skrivebeskyttet filsystem, ingen Linux-rettigheder, `no-new-privileges` | En ny volumen blev ejet af root, så serveren (uid 1000) kunne ikke gemme sin database | CI-job `docker` |

## Valgt fra – og hvorfor

- **Opslag i "Have I Been Pwned"** ved ny adgangskode: ville kræve et netværksopslag fra skolens server for hver ny adgangskode. Den lokale blokliste fanger de adgangskoder, der prøves først; kan tilføjes som valgfri indstilling.
- **Trusted Types** (`require-trusted-types-for 'script'`): ville kræve omskrivning af dashboardet. `script-src 'self'` uden `unsafe-inline` forhindrer allerede indsprøjtede scripts i at køre.
- **Kortere inaktivitet end 12 timer**: læreren har dashboardet åbent hele skoledagen; et kortere login ville betyde nyt login midt i en lektion. Lektionen kører videre på serveren under alle omstændigheder.

## Mangler (kræver en beslutning eller et køb)

- [ ] **Kodesignering** af elev-appen (Windows-certifikat, Apple Developer ID) – uden den advarer Windows og macOS, og Smart App Control blokerer.
- [ ] **Uafhængig penetrationstest** før salg til den første skole.
- [ ] **Hændelsesberedskab**: hvem underrettes, og hvordan, ved et brud (art. 33: skolen skal underrette Datatilsynet inden 72 timer; HolyMoly skal underrette skolen uden unødig forsinkelse).

Fund sikkerhedsfejl? Skriv til adressen i `/.well-known/security.txt` (RFC 9116; sættes med `SECURITY_CONTACT`, ellers `COMPANY_EMAIL`) – ikke i et offentligt issue.
