# HolyMoly i enkel tilstand

Til at komme i gang på én skole – uden e-mail, licens, to-faktor eller Unilogin. Programmet er det samme (blokering, lamper, skrive-bevis, afleveringer); kun login og opsætning er gjort enklere.

| | Almindelig | Enkel |
| --- | --- | --- |
| Lærer logger ind med | E-mail + adgangskode (+ evt. to-faktor/Unilogin) | Brugernavn + adgangskode |
| Elev tilmelder sig med | Klassekode + navn (eller Unilogin) | Klassekode + navn + egen kode (4-6 cifre) |
| Glemt adgangskode | Link på e-mail | `npm run enkel -- nulstil <brugernavn>` på serveren |
| Licens og prøveperiode | Ja (hostet) | Nej |
| Vilkår | Skolen accepterer ved oprettelse | Læreren accepterer ved oprettelse, eleven i appen ved tilmelding (/vilkaar-elev) |

## Start

```bash
npm install --prefix server
npm run enkel
```

Åbn `http://localhost:8080`, opret en lærer (navn, brugernavn, adgangskode på mindst 10 tegn) og lav en klasse. Klassekoden står i klassen.

## Vilkår

- Læreren sætter flueben ved vilkårene, når kontoen oprettes.
- Eleven ser en kort forklaring af, hvad HolyMoly ser, og sætter flueben ved "vilkårene for elever" i appen. Uden flueben tilmeldes eleven ikke. Tidspunktet gemmes (`students.terms_accepted`).
- Vilkårene for elever ligger på `/vilkaar-elev` og kan åbnes fra appen.

## Lærere og lærerkoden

- Den første lærer bruger **opsætningskoden**, som serveren skriver i loggen, når den starter (`Opsætningskode til første lærer: XXXX-XXXX`). Koden virker én gang.
- Derefter kræves **lærerkoden**. En lærer klikker *Vis kode* under *Konto → Kolleger*. Koden gælder i 30 minutter.
- En ny lærer skal **godkendes af en kollega**, før kontoen kan bruges. Den nye lærer ser "Din konto venter på godkendelse". Kollegerne ser "Ny lærer venter: navn (oprettet dato kl. tid) – Godkend / Afvis" øverst på siden med klasserne. *Afvis* sletter kontoen. Så kan en elev, der har set koden, ikke få en lærerkonto.
- *Lav ny lærerkode* gør den gamle ugyldig. Lærere, der allerede er oprettet, mærker intet.
- Kan ingen kollega godkende (fx hvis den eneste godkendte lærer er stoppet), kan den, der driver serveren, gøre det: `node scripts/enkel.js godkend <brugernavn>` (i Docker: `docker compose -f deploy/docker-compose.yml exec holymoly node /app/scripts/enkel.js godkend <brugernavn>`).

## Elevernes kode

- Eleven vælger selv en kode på 4-6 cifre første gang.
- Med koden kan eleven logge ind igen på en anden computer. Den gamle computer logges ud.
- Skriver nogen et navn, der allerede er tilmeldt, kræves den rigtige kode. Efter 5 forkerte forsøg venter man et par minutter, og læreren kan se forsøget i elevens log.
- Har eleven glemt koden: læreren slår *Rediger borde* til, klikker på eleven og vælger **Nulstil kode**. Læreren får en engangskode på 6 cifre. Inden for 30 minutter skriver eleven klassekoden, sit navn og engangskoden i appen. Engangskoden er derefter elevens kode, og eleven beholder sin plads, sin log og sine dokumenter.
- Efter 10 forkerte forsøg er elevens kode låst for nye computere, indtil læreren nulstiller den. Den computer, eleven allerede er logget ind på, virker stadig – også uden kode. Så kan en klassekammerat ikke låse eleven ude lige før en prøve.
- Forkerte forsøg tæller også pr. IP-adresse (30, rummeligt for en hel skole bag én adresse) og pr. klasse (20). Derefter venter man et par minutter.
- Svaret er det samme, uanset om navnet findes, koden er forkert, eller koden er låst. Eleven selv får en fast besked i appen: "Nogen har prøvet at logge ind med dit navn og en forkert kode."
- Meget lette koder (1111, 1234, årstal osv.) kan ikke vælges.

## Elev-appen kræver https

Appen forbinder kun til en `https://`-adresse (eller `localhost`). To måder:

1. **Hurtig test:** `cloudflared tunnel --url http://localhost:8080` giver en gratis `https://…trycloudflare.com`-adresse. Den skifter ved hver genstart.
2. **Fast på egen server (Proxmox):** se [PROXMOX.md](PROXMOX.md).
3. **Fast på lejet server:** En lille server i EU (fx Hetzner) med et domæne og Caddy foran (`caddy reverse-proxy --from holymoly.dit-domæne.dk --to localhost:8080`), som henter certifikatet selv.

Sæt `PUBLIC_URL` til https-adressen, så tjek-linket på skrive-beviset bliver rigtigt:

```bash
PUBLIC_URL=https://holymoly.dit-domæne.dk npm run enkel
```

## Skolens ja (kræves før lektioner)

I enkel tilstand kan der først startes lektioner og skriveøkter, når skolens godkendelse er skrevet ind på serveren:

| Variabel | Eksempel |
| --- | --- |
| `DATAANSVARLIG` | Aarhus Katedralskole, CVR 12345678 |
| `DPO_KONTAKT` | dpo@skole.dk |
| `DPIA_DATO` | 2026-12-01 |
| `LEDELSE_JA_DATO` | 2026-12-03 |

Felterne vises på privatlivssiden, så elever og forældre kan se, hvem der er ansvarlig.

### Låst konfiguration

Når skolens ja er udfyldt, gemmer serveren et fingeraftryk af det, skolen sagde ja til: hvilke funktioner der er slået til (`BETA_FEATURES`, også "Skriv i Word"), fristerne, `REQUIRE_GUARD` og signeringsnøglens keyId. Ingen hemmeligheder.

- Ændres noget bagefter, står der "ændret siden DPIA: …" i startlinjen i loggen, på `/healthz?deep=1` (svarer 503) og i tjeklisten på beta-forsiden.
- Nye lektioner og skriveøkter blokeres **kun**, når en overvågningsfunktion er slået til siden (live-skærm, skærmbilleder, automatiske skærmbilleder, lighedstjek eller Skriv i Word). Ændrede frister blokerer aldrig, og en lektion, der er i gang, stoppes aldrig.
- Få skolens ja til ændringen, og kør `npm run enkel -- bekraeft-ja` med samme miljø som serveren (i Docker: `docker compose exec holymoly node /app/scripts/enkel.js bekraeft-ja`). Det står i revisionssporet. Nye datoer i `DPIA_DATO` eller `LEDELSE_JA_DATO` er et nyt ja og registrerer konfigurationen igen.
- Eleverne har accepteret vilkårene med de funktioner, der var slået til. Ændres funktionerne, beder elev-appen eleven om at læse vilkårene igen og trykke "Jeg har læst dem". `/privatliv` og `/vilkaar-elev` viser, hvad der er slået til på serveren.

## Testserver eller skolens server

Den, der driver serveren, har signeringsnøglen og kan læse alle elevdata. Kører serveren hos en elev eller privatperson, er det en **testserver**, og beviserne siger "Testserver – må ikke bruges til bedømmelse". Når skolens IT driver serveren og ejer nøglen, sættes `SCHOOL_OPERATED=1`.

Lektioner kræver også, at driften er på plads. Enten er der en databehandleraftale med den, der driver serveren (en voksen eller en juridisk person): sæt `DBA_DATO`. Eller skolens IT har overtaget driften: sæt `SCHOOL_OPERATED=1`, og kør `npm run enkel -- overdrag` (i Docker: `docker compose exec holymoly node /app/scripts/enkel.js overdrag`). Uden en af delene svarer serveren: "Serveren drives ikke af skolen, og der er ingen databehandleraftale. Bed skolens IT om at overtage driften."

| Variabel | Eksempel |
| --- | --- |
| `DBA_DATO` | 2026-11-20 |
| `DRIFTSANSVARLIG` | en lærer på skolen (en rolle, ikke et navn – står på forsiden) |
| `BETA_FEATURES` | tom. Beta har ingen live-skærm, ingen skærmbilleder, intet lighedstjek og ingen "Skriv i Word". `liveScreen,screenshot` slår dem til |

### Skriv i Word slås til

"Skriv i Word" er slået fra i beta. Elev-appen viser ikke knappen, og serveren afviser Word-gemninger. Slå det først til, når hele den manuelle testplan i docs/WORD.md er kørt og bestået på 2-3 af skolens egne Windows-maskiner med Word:

1. Kør testplanen i docs/WORD.md ("Manuel testplan"). Notér resultatet af hvert trin.
2. Sæt `BETA_FEATURES=word` i `.env` (flere funktioner adskilles med komma, fx `word,liveScreen`).
3. Genstart serveren (`docker compose up -d`). Elev-appen viser "Skriv i Word", næste gang den forbinder.

Slå det fra igen ved at fjerne `word`. Påbegyndte Word-dokumenter kan så ikke afleveres med mærke; eleven skriver videre i skrivevinduet.

Forsiden i enkel tilstand er beta-forsiden: ingen priser, ingen prøveperiode og ingen Unilogin. Den viser, hvem der driver serveren, tjeklisten "Skolens ja" og nødproceduren.

## Før rigtige elever bruger det

Elevernes accept dækker informationen til eleverne. Den erstatter ikke skolens ja: skolen er dataansvarlig, og elever kan ikke frit sige nej til noget, der bruges i undervisningen. Få et kort ja fra ledelsen, og send databehandleraftalen til skolens DPO. Se handlingsplanen ("Start: gratis på egen skole").

## Databasen

HolyMoly bruger SQLite: én fil, `holymoly.db`, i datamappen. Der er ingen separat databaseserver at installere eller passe.

- Hver nat laves en hel kopi i `backup/holymoly-ÅÅÅÅ-MM-DD.db` i datamappen. De seneste 14 gemmes (`BACKUP_DAYS`). Signeringsnøglen (`proof-key.pem`) ligger aldrig der i klartekst.
- Backup ud af huset: `npm run enkel -- backup-ud <mål>` laver én krypteret fil med databasen og nøglen (kræver `BACKUP_PASSPHRASE`). Tjek den med `npm run enkel -- gendan-test <fil>`. Nøgleskifte: `npm run enkel -- ny-noegle`. Se docs/PROXMOX.md.
- Skærmbilleder ligger i `evidence/` ved siden af.
- En kopi kan åbnes med ethvert SQLite-værktøj, fx DB Browser for SQLite.

## Revisionsspor

Serveren gemmer, hvilken lærer der gjorde hvad hos hvilken elev og hvornår (fx åbnede et dokument, afspillede, hentede Word, så weblog eller faner, gav ekstra tid, ændrede hjælpemidler, eksporterede, slettede eller nulstillede en kode). Der gemmes intet indhold. Sporet kan kun tilføjes til, og det slettes efter `AUDIT_DAYS` (365). Slettes en elev, står der kun et pseudonym.

```bash
npm run enkel -- revisionsspor 90 > revisionsspor.csv
```

## Pilottal

Lærerne kan trykke **Var det forkert?** ved en rød lampe (i elevskuffen) og ved et afslag på mærket (i dokumentet). Serveren gemmer kun dagen, årsagskoden og om det var i timen, hjemme eller i Word – ikke hvem. Markeringerne slettes efter `AUDIT_DAYS`.

```bash
npm run enkel -- pilottal 2027-02 > pilottal-2027-02.csv
```

CSV'en har kun månedstal for hele skolen: antal lektioner, minutter til alle er grønne (median), lektioner hvor ikke alle blev grønne, grå og røde minutter pr. årsag, afleveringer, andel med mærke, afslag pr. årsag, andel markeret forkert, driftsforstyrrelser (serveren stoppede uden at lukke pænt) og åbnede afspilninger. Der er ingen opdeling pr. lærer, klasse eller elev, ingen navne og ingen tælling af AI-forsøg. Et tal, der bygger på færre end 5, vises ikke ("færre end 5"). Lampens minutter bygger på lektionsrapporten, som slettes efter `LOG_RETENTION_DAYS` – kør kommandoen hver måned. Spørgeskemaet til lærere og elever køres på papir eller i Forms uden for HolyMoly.

## Indstillinger

| Variabel | Standard | |
| --- | --- | --- |
| `PORT` | 8080 | |
| `DATA_DIR` | `server/data` | Database og skærmbilleder |
| `PUBLIC_URL` | – | https-adressen |
| `BACKUP_DAYS` | 14 | Antal daglige kopier af databasen; 0 = slået fra |
| `DRAFT_DAYS` | 60 | Kladder slettes så mange dage efter seneste ændring |
| `VERSIONS_DAYS` | 60 | Afspilning og skrivedetaljer slettes så mange dage efter aflevering |
| `DOC_RETENTION_DAYS` | 365 | Afleverede dokumenter slettes så mange dage efter aflevering (beviset bliver uden navn) |
| `CERT_YEARS` | 3 | Beviser kan tjekkes så mange år; derefter svarer tjek-siden "udløbet" |
| `LOG_RETENTION_DAYS` | 30 | Hændelser, skærmbilleder, lampernes tidslinje og skriveøkter hjemme |
| `AUDIT_DAYS` | 365 | Revisionssporet (lærerhandlinger uden indhold) slettes så mange dage efter |
| `INACTIVE_STUDENT_DAYS` | 180 | Hjælpemidler, ekstra tid og computeroplysninger slettes, når eleven ikke har været forbundet så mange dage |
| `REQUIRE_GUARD` | 1 | `0`: elever kan være grønne uden HolyMoly-vagten (kun til test) |

## Ny elev-app

Når en ny version af elev-appen udgives, så hæv `MIN_AGENT_VERSION` til den nye version (fx `MIN_AGENT_VERSION=1.2.5`). Ældre apps bliver så grå hos læreren og beder eleven om at opdatere. Det er vigtigt, når den nye version lukker et sikkerhedshul. Fx nægter appen fra og med denne version at starte med fejlfinding slået til (`--remote-debugging-port`, `--inspect`), men en gammel app kan stadig startes sådan.
