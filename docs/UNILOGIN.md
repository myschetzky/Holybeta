# Unilogin i HolyMoly – sådan kommer det rigtige login i drift

HolyMoly taler allerede med Unilogin-brokeren hos Styrelsen for IT og Læring (STIL). Koden ligger i `server/src/oidc.js` og er testet i `test/unilogin.test.js` mod en simuleret broker. Det, der mangler, er aftalerne og nøglerne fra STIL. De kan kun I skaffe, fordi det kræver jeres CVR og MitID Erhverv.

Login foregår sådan: Brugeren trykker "Log ind med Unilogin" og ser STIL's egen loginvælger (Unilogin, MitID eller skolens lokale login). Bagefter kommer brugeren tilbage til HolyMoly.

## 1. Fakta om brokeren (tjekket 2026-11-24)

| | Værdi |
|---|---|
| Issuer (produktion) | `https://broker.unilogin.dk/auth/realms/broker` (standard i HolyMoly) |
| Metadata | `…/.well-known/openid-configuration` |
| Protokol | OIO OIDC (Keycloak), Authorization Code Flow med **PKCE S256**, fortrolig klient (`client_secret_basic`) |
| Signatur | RS256 med et OCES-certifikat fra Den Danske Stat |
| id_token | `sub`, `uniid`, `aktoer_gruppe`, `institution_ids`, `unilogin_loa` – **ingen e-mail** |
| userinfo | `inst_brugere`: `instnr` og `instnavn` for hver institution |
| Kræver dataaftale | **Navn og roller** (udvidet brugerinformation) – kun når den enkelte skole har godkendt det |
| Sikringsniveau | `acr_values` kan fx være `https://data.gov.dk/concept/core/nsis/loa/Substantial`. Standard er uden krav, så Unilogin med adgangskode virker |

Kilder: brokerens egen metadata og STIL's vidensbase "Unilogin – teknisk information". Erfaringerne med claims kommer fra andre udbyderes offentlige integrationer (bl.a. Skoleoverblikket og fafnir-sso). Tjek dem i testmiljøet, før I går i produktion.

## 2. Trin for trin hos STIL

1. **Bliv oprettet som udbyder.** Skriv til STIL via supportformularen på stil.dk/support ("Tilslutning.stil.dk"). Oplys CVR, firmanavn, en e-mail til notifikationer, det ønskede navn i Tilslutning, formålet (skrive-bevis og overblik i undervisningen) og en kontaktperson på en skole.
2. **MitID Erhverv** med rettighederne
   - "Tilslutning: Ret til at administrere aftaler på tilslutning.stil.dk"
   - "Udbyderportal: Ret til at administrere tjenester".
3. **tilslutning.stil.dk:** Opret tjenesten "HolyMoly", og anmod om tilslutning til **Unilogin Broker (OIDC)**. Her underskrives **tilslutningsaftalen** med STIL.
4. **udbyderportal.stil.dk** (fanen *Tjenester*): Opret OIDC-tjenesten med
   - redirect URI: `https://<jeres domæne>/api/auth/unilogin/callback`
   - post-logout URI: `https://<jeres domæne>/login`
   - PKCE: S256
   - scope: `openid`
   - userinfo som JSON (ikke signeret).
   Start med testtjenesten.
5. **Indstil serveren** (`deploy/.env`):
   ```
   UNILOGIN_CLIENT_ID=<fra udbyderportalen>
   UNILOGIN_CLIENT_SECRET=<fra udbyderportalen>
   UNILOGIN_REDIRECT_URI=https://<jeres domæne>/api/auth/unilogin/callback
   # UNILOGIN_ISSUER er sat til produktionsbrokeren som standard – sæt den til testbrokeren under test
   ```
6. **Hver skole godkender en dataaftale** i sit eget Unilogin-administrationsværktøj. Bed om **udvidet brugerinformation (navn og roller)**, så klasseværelset kan vise elevernes navne. Uden navnene kan eleverne stadig bruge klassekoden og skrive deres navn selv.
7. **Databehandleraftalen** mellem skolen og jer er den, der ligger på `/databehandleraftale`. Skolen skal ikke have en særskilt aftale med STIL.

## 3. Pris hos STIL (ekskl. moms)

STIL tager betaling for tilslutningen, også for en enkelt tjeneste. Priserne nedenfor er offentliggjort i STIL's servicebeskrivelse under "Priser" (som en anden udbyder har gengivet dem i 2026). Bekræft dem hos STIL, før I bestiller.

| | Etablering | Årsabonnement |
|---|---|---|
| Første tjeneste, under 2.000 logins om ugen | 7.500 kr. | 7.500 kr. |

- Etableringen faktureres 3 måneder efter bestillingen.
- Abonnementet starter 9 måneder efter bestillingen.
- Første år koster altså ca. 15.000 kr. og derefter 7.500 kr. om året.
- Med 129 kr. pr. elev er det betalt af godt 120 elever. Én mellemstor skole dækker det.

**Anbefaling:** Bestil først tilslutningen, når den første skole har sagt ja til en pilot. Indtil da logger lærere ind med e-mail og to-faktor, og elever bruger klassekoden. Begge dele virker allerede.

## 4. Sådan bruger HolyMoly svaret fra Unilogin

- **UNI-ID (`uniid`)** binder en elev til samme plads i klassen, også på en ny computer, og en lærer til sin konto.
- **Brugertype (`aktoer_gruppe`) og roller** afgør, om en ny Unilogin-konto må blive lærer (`UNILOGIN_TEACHER_ROLES`). Eleverne kan aldrig blive lærere.
- **Institutionsnumre** (`institution_ids` / `inst_brugere`) kobler lærere og elever til den rigtige skole i HolyMoly. Se "Skolens institutionsnummer" under Skole.
- **Navn:** Uden dataaftale med navne bruger lærerkontoen navnet "Lærer", som læreren selv kan rette under Konto. Elev-appen beder eleven bruge klassekoden.
