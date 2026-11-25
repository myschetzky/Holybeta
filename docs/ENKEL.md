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
- Derefter kræves **lærerkoden**. Den står under *Konto → Kolleger* hos alle lærere. Så kan en elev ikke oprette sig som lærer, selvom serveren er offentlig.
- *Lav ny lærerkode* gør den gamle ugyldig. Koden skifter også af sig selv efter 14 dage. Lærere, der allerede er oprettet, mærker intet.

## Elevernes kode

- Eleven vælger selv en kode på 4-6 cifre første gang.
- Med koden kan eleven logge ind igen på en anden computer. Den gamle computer logges ud.
- Skriver nogen et navn, der allerede er tilmeldt, kræves den rigtige kode. Efter 5 forkerte forsøg venter man et par minutter, og læreren kan se forsøget i elevens log.
- Har eleven glemt koden: læreren slår *Rediger borde* til, klikker på eleven og vælger **Nulstil kode**. Læreren får en engangskode på 6 cifre. Inden for 30 minutter skriver eleven klassekoden, sit navn og engangskoden i appen. Engangskoden er derefter elevens kode, og eleven beholder sin plads, sin log og sine dokumenter.
- Efter 10 forkerte forsøg er elevens kode låst, indtil læreren nulstiller den.
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

## Testserver eller skolens server

Den, der driver serveren, har signeringsnøglen og kan læse alle elevdata. Kører serveren hos en elev eller privatperson, er det en **testserver**, og beviserne siger "Testserver – må ikke bruges til bedømmelse". Når skolens IT driver serveren og ejer nøglen, sættes `SCHOOL_OPERATED=1`.

## Før rigtige elever bruger det

Elevernes accept dækker informationen til eleverne. Den erstatter ikke skolens ja: skolen er dataansvarlig, og elever kan ikke frit sige nej til noget, der bruges i undervisningen. Få et kort ja fra ledelsen, og send databehandleraftalen til skolens DPO. Se handlingsplanen ("Start: gratis på egen skole").

## Databasen

HolyMoly bruger SQLite: én fil, `holymoly.db`, i datamappen. Der er ingen separat databaseserver at installere eller passe.

- Hver nat laves en hel kopi i `backup/holymoly-ÅÅÅÅ-MM-DD.db` i datamappen. De seneste 7 gemmes (`BACKUP_DAYS`).
- Skærmbilleder ligger i `evidence/` ved siden af.
- En kopi kan åbnes med ethvert SQLite-værktøj, fx DB Browser for SQLite.

## Indstillinger

| Variabel | Standard | |
| --- | --- | --- |
| `PORT` | 8080 | |
| `DATA_DIR` | `server/data` | Database og skærmbilleder |
| `PUBLIC_URL` | – | https-adressen |
| `BACKUP_DAYS` | 7 | Antal daglige kopier af databasen; 0 = slået fra |
| `REQUIRE_GUARD` | 1 | `0`: elever kan være grønne uden HolyMoly-vagten (kun til test) |
