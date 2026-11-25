# Design – web (server/public)

Gælder forsiden, beta-forsiden, login/opret, lærer-dashboardet, tjek-siden (/bevis) og dokumentsiderne.
Elevens app og Word-rammen (agent/) har deres egen gennemgang.

## Faste krav

- Enkelt og sagligt, rettet mod en skole. Ingen emojis, ingen ikoner som pynt, ingen farveforløb.
- Overskriften "Elevernes bevis på, at deres tekst ikke er skrevet med AI" ændres ikke.
- Dansk, korte sætninger.
- WCAG 2.1 AA i lyst og mørkt tema (`npm run a11y` tjekker lyst tema).
- Teksturer: kun CSS og inline SVG, én tone (HolyMoly-blå), aldrig bag brødtekst, og aldrig alene om at bære en betydning.
  De slås fra ved `prefers-contrast: more`. Bevægelse respekterer `prefers-reduced-motion`.

## Tokens

Står øverst i `site.css` (offentlige sider) og `app.css` (dashboard og tjek-side). Samme navne og skala begge steder.
Lyst tema er standard. Mørkt tema vælges i dashboardet (Indstillinger, `data-hm-theme="dark"` på `<html>`) og gælder også forsiderne.

| Token | Lyst | Mørkt | Bruges til |
|---|---|---|---|
| `--bg` | `#f4f5f7` (site: `#fff`) | `#111317` | sidens baggrund |
| `--panel` | `#fff` | `#1a1d23` | kort, dialoger, skuffe |
| `--text` / `--muted` | `#16181d` / `#596170` | `#eceef2` / `#9aa1ad` | tekst / sekundær tekst |
| `--line` / `--line-strong` | `#e3e5ea` / `#c9ced8` | `#2b3039` / `#3d4450` | skillelinjer / kanter på borde og felter |
| `--accent` | `#2f5bea` | `#7d9bff` | links, fokus, primær handling |
| `--accent-ink` | `#fff` | `#0b1020` | tekst på primærknapper (mørk tekst på lys blå i mørkt tema – AA) |
| `--green` / `--green-text` | `#16a34a` / `#166534` | – / `#4ade80` | lampe / grøn tekst |
| `--red` / `--red-text` | `#dc2626` / `#b91c1c` | – / `#f87171` | lampe / rød tekst |
| `--amber` / `--warn-text` | `#f59e0b` / `#92400e` | – / `#fbbf24` | Hånd op, advarsler |
| `--grey` / `--idle` | `#9ca3af` / `#cbd5e1` | `#6b7280` / `#3a4250` | grå lampe / forbundet uden lektion |
| `--floor` | `#f8f9fb` | `#15181d` | klasseværelsets gulv |
| `--tex`, `--tex-dot`, `--tex-line`, `--tex-alpha` | accent, 20 %, 7 %, .16 | accent, 30 %, 9 %, .22 | teksturernes blæk og dækning |

- Afstande (4-punkts skala): `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 24 · `--s6` 32 · `--s7` 48 (site også `--s8` 64, `--s9` 88).
- Radier: `--r-xs` 4 · `--r-sm` 6 · `--r-md` 8 · `--r-lg` 10 (site 12) · `--r-xl` 14 · `--r-pill`.
- Skygger: `--shadow` (kort og borde), `--sh-pop` (dialoger, toast), site `--sh-1` (skærmbilleder).
- Typografi: systemfont (`--font`), `--mono` til koder. Dashboard `--fs-xs` 12 · `--fs-sm` 13 · `--fs-base` 15 · `--fs-md` 17 · `--fs-lg` 19 · `--fs-xl` 22 · `--fs-2xl` 24. Site 14/15/17/18/19 og `clamp()` til overskrifter.

## Status ser ens ud overalt (law of similarity)

| Status | Form | Hvor |
|---|---|---|
| Grøn / rød / grå lampe | rund prik + tekst | bordene, skuffen, forklaringen, forsiden |
| Tællere i topbaren | samme farveprik (klassen `.dot`, ikke `.lamp`, så e2e kun tæller bordene) | klasseværelset |
| Hånd op | ravgult tekstmærke "Hånd op" + ravgul kant på bordet | bordet, forklaringen, tællerne |
| Frosset | blå kant + fanebladet "Frosset" på bordets kant | bordet, forklaringen, info-knappen |
| Skriver hjemme | stiplet kant | bordet |
| Dommen på tjek-siden | samme flade, farvet venstrekant (grøn/rød/ravgul/grå) | /bevis |

Emojis (✋, ❄) er erstattet af tekst og former. Farven bærer aldrig betydningen alene.

## Teksturer

| Tekstur | Hvor | Hvorfor |
|---|---|---|
| Blueprint / square-dot grid | klasseværelsets gulv (`.room`) | Klasseværelset er en plantegning. Prik hver 24 px, linje hver 5. prik. Bordene, tavlen og tom-kortet har egen flade, så ingen tekst står på mønsteret. |
| Konturlinjer (topografisk kort) | forsidens hero, højre side | "Overblik". Inline SVG (3,4 KB) brugt som maske, så farven følger temaet. Fader ud, før teksten begynder. |
| Halvtone | beta-forsidens hero | Prøvetryk: en nøgtern side til én skole. Ren CSS (`radial-gradient`). |

Fravalgt:

- Papir/filt bag tjek-siden og dokumentvisningen: det ville stå bag brødtekst. Forseglingen vises i stedet som et "stempel" (mærket i en kant).
- Grainy/stippled støj på flader: gav ingen bedre læsbarhed og fylder i CSS.
- Fluted glass, iridescent, lens distortion, cloud sky, impressionistisk, pixel/ASCII, græs, vand, termiske forløb: passer ikke til en skole og ville ligne "vibecoded" pynt.

## Audit (november 2026) – principper og ændringer

| Skærm | Brudte principper | Ændring |
|---|---|---|
| Forside | Aesthetic-usability (ingen dybde i hero), mørkt tema manglede | Tokens, mørkt tema, konturlinjer i hero. Én primær handling (Start prøveperiode) bevaret. |
| Beta-forside | Goal-gradient (tjeklisten viste ikke fremgang) | "N af 6 er på plads" med en bjælke over tjeklisten. Halvtone i hero. |
| Login | Von Restorff (to fyldte knapper: Unilogin uden opsætning og Log ind), fejl: "medUnilogin" uden mellemrum | Unilogin uden opsætning er stiplet og neutral, så "Log ind" er den eneste fyldte knap. Mellemrummet er rettet. |
| Klasser (tom) | Zeigarnik / goal-gradient | Første trin i "Kom i gang" er markeret som det næste skridt. |
| Klasseværelset | Prägnanz og common region (tomt gulv uden struktur), similarity (✋ og ❄ som emojis, tællere uden farve), uniform connectedness | Prikgitter, statusmærker i samme form, tællere med lampernes farver. Klassekoden viger før tællerne på smalle bærbare (findes i menuen og i tom-tilstanden). |
| Klasseværelset, telefon | Bordene dækkede hinanden | Bordene bliver en liste i to kolonner i bordenes rækkefølge (forfra, venstre mod højre). DOM-rækkefølgen følger også bordene for skærmlæsere. |
| Elevskuffen | Cognitive load og progressive disclosure (otte knapper, navnet blev klemt) | Navn og luk på første linje. Hyppige handlinger synlige (skærmbillede, frys, + tid, Var det forkert?), sjældne under "Flere valg" (eksport, hjælpemidler, uden HolyMoly). |
| Afleveringer (dialog) | Von Restorff (to primærknapper: "Ny aflevering" og "Luk") | "Luk" er neutral. |
| Toast | Peak-end (sort boks uden afslutning), ingen live-region | Rolig kvittering med grøn kant, `role="status"`. |
| Tjek-siden | Prägnanz (rå filvælger i feltet), peak-end (dommen "Beviset findes" uden form) | Hele feltet er filvælgeren med én knap. Dommen har samme flade for alle udfald, kun kanten skifter farve. Mærket vises som stempel. |
| Dokumentsider | – | Arver tokens og mørkt tema. Tilbuddet forbliver et lyst papirdokument. |

Næste skridt, ikke gjort her: skrivetimens nedtælling som lille bjælke (Parkinson), "Fortsæt kladde" i elevens app (agent/), og en samlet ikonfri knapstil for topbarens mange knapper på telefon.

## Regler for nye skærme

1. Én primær (fyldt) knap pr. skærm eller dialog. Resten er neutrale.
2. Sjældne valg bag "Flere valg" eller `<details>`. Fornuftige standarder, så læreren ikke skal vælge.
3. Tomme tilstande siger, hvad næste skridt er, og står på en egen flade.
4. Brug tokens – ingen nye hex-farver i regler. Mørkt tema skal tjekkes (axe) før commit.
5. Rør ikke e2e-selektorerne (listen i COWORK.md) uden at rette `test/e2e/run.js`.
