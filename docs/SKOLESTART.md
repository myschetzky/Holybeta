# HolyMoly beta – kom i gang på skolen

Holybeta er gratis og til test på én skole. Følg trinene i rækkefølge. Hvert trin har én ansvarlig.

> **Ikke til prøver eller eksamen.** Elever, der ikke kan bruge HolyMoly, afleverer som normalt i Lectio.

## 1. Ledelsen og DPO (før alt andet)

| | Hvad | Hvor |
| --- | --- | --- |
| ☐ | Ledelsen siger ja skriftligt (dato) | – |
| ☐ | DPO har set databehandleraftalen og konsekvensanalysen (datoer) | `/databehandleraftale`, [JURA.md](JURA.md), [SIKKERHED.md](SIKKERHED.md) |
| ☐ | Elever og forældre er informeret | `/vilkaar-elev`, `/privatliv` |
| ☐ | Det er aftalt, hvem der driver serveren (helst skolens IT) | [PROXMOX.md](PROXMOX.md) |

Datoerne skrives ind på serveren i trin 2. Uden dem kan der ikke startes lektioner.

> Kører serveren i Docker, skrives `npm run enkel -- <kommando>` som `docker compose -f deploy/docker-compose.yml exec holymoly node /app/scripts/enkel.js <kommando>`.

## 2. IT: serveren

1. Hent koden: `git clone https://github.com/myschetzky/Holybeta.git` (eller zip-filen fra den nyeste udgivelse under *Releases*).
2. Følg [PROXMOX.md](PROXMOX.md) (Docker + Caddy med skolens domæne). Kopiér `deploy/.env.beta.example` til `deploy/.env` og udfyld:
   - `PUBLIC_URL` – serverens https-adresse
   - `DATAANSVARLIG`, `DPO_KONTAKT`, `DPIA_DATO`, `LEDELSE_JA_DATO` – fra trin 1
   - `DBA_DATO` (databehandleraftale) – eller kør `npm run enkel -- overdrag`, når skolens IT driver serveren selv
   - `BACKUP_PASSPHRASE` – til den krypterede backup ud af huset
3. Start serveren og notér **opsætningskoden** fra loggen (`Opsætningskode til første lærer: XXXX-XXXX`).
4. Tjek: `https://<adresse>/healthz` svarer `ok`, og beta-forsiden viser "Skolens ja" uden mangler.
5. Sæt en ugentlig `npm run enkel -- backup-ud <mål>` op, og prøv én gang `npm run enkel -- gendan-test <fil>`.

## 3. IT: elevernes computere

1. Hent installationsfilerne fra den nyeste udgivelse under *Releases* (Windows `.exe`, Mac `.pkg`).
2. Installér med serverens adresse (Windows: `/SERVER=https://<adresse>`), eller lad eleverne skrive adressen ved første start.
3. Browser-udvidelsen: zip-filerne ligger i udgivelsen. Indtil den er i Chrome Web Store, lukkes browsere uden udvidelsen ikke.
4. Appen er endnu ikke kodesigneret. Windows SmartScreen og macOS kan advare første gang – det er forventet i beta.
5. "Skriv i Word" er slået fra i beta. Slå det først til (`BETA_FEATURES=word`), når testplanen i [WORD.md](WORD.md) er kørt på 2-3 af skolens pc'er.

## 4. Lærerne

1. Den første lærer opretter sig på serveren med opsætningskoden.
2. Kolleger opretter sig med **lærerkoden** (Konto → Kolleger → Vis kode) og godkendes af en kollega.
3. Lav en klasse, skriv klassekoden på tavlen, og lav en prøvelektion på 10 minutter.
4. Læs [LAERERVEJLEDNING.md](LAERERVEJLEDNING.md) (1 side) – især: manglende mærke er ikke bevis for snyd, og nødproceduren.

## 5. Eleverne

1. Åbn HolyMoly-appen, skriv klassekoden, dit navn og en kode på 4-6 cifre, og læs, hvad HolyMoly ser.
2. Skriv i HolyMolys skrivevindue, tryk "Afslut dokument", og aflever under "Afleveringer".
3. Elever med ordblinde-programmer: sig det til læreren (Hjælpemidler). Se [ORDBLINDE-TEST.md](ORDBLINDE-TEST.md).

## Under piloten

- `npm run enkel -- pilottal` hver måned (samlede tal, ingen navne).
- Læreren trykker "Var det forkert?" ved røde lamper eller afslag, der ikke passer.
- Fejl og idéer: opret et issue i [Holybeta](https://github.com/myschetzky/Holybeta/issues).
