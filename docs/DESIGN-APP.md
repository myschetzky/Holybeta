# Design: elev-appen (agent/renderer)

Gælder hovedvinduet (tilmelding, status, afleveringer), skrivevinduet, Word-rammen med muldvarpen,
Min HolyMoly og frys-/gennemgangsskærmen. Web og lærer-dashboard: se `docs/DESIGN.md`.

Ejerens faste krav går forud for alt herunder: ingen emojis, ingen ikoner som pynt, ingen
"galaxy"-gradienter. Enkelt og sagligt, rettet mod en skole. Dansk, korte sætninger.

## Tokens (`agent/renderer/tokens.css`)

Alle vinduer indlæser `tokens.css` før deres egen CSS (frys-skærmen undtaget: den har sin egen mørke palet
og en CSP uden billeder).

| Token | Værdi | Brug |
|---|---|---|
| `--hm-blue` | `#2f5bea` | HolyMoly-blå: primær knap, Word-kanten, fremdrift |
| `--hm-blue-ink` / `-50` / `-200` | `#1e3a8a` / `#eef3ff` / `#c7d5fb` | blå tekst, lyse blå flader og kanter |
| `--hm-grey-0 … -900` | hvid → `#16181d` | neutrale flader, linjer og tekst |
| `--hm-green(-ink)`, `--hm-red(-ink)` | | **kun status** (lampe, mærke, fejl) – aldrig pynt |
| `--hm-paper` | `#fffefb` | arket i skrivevinduet og kvitteringer |
| `--s-1 … --s-6` | 4/8/12/16/24/32 px | afstande |
| `--r-1 … --r-3` | 6/8/12 px | hjørner |

Navnene følger web-delen, hvor det giver mening (HolyMoly-blå, neutrale grå, 4/8/12/16/24/32).

## Teksturer

| Tekstur | Hvor | Hvorfor |
|---|---|---|
| Papir (fin fiberstøj, `--tex-paper`) | Arket i skrivevinduet, kvitteringen efter "Afslut" og efter "Aflever", stemplet i Word-rammen, afsluttede dokumenter | Eleven skriver på et ark. Et forseglet dokument er et stykke papir med et stempel. |
| Filt (`--tex-felt`) | Bordet bag arket | Giver arket dybde uden skygger og farver. |
| Kvadratisk prikgitter (`--tex-dots` / `--tex-empty`) | Tomme tilstande (afleveringer, Min HolyMoly, skrivevinduets afleveringer) | "Her kommer noget" – en tom plantegning. |

Regler:

- Kun SVG-data-URI i CSS. Ingen filer, ingen eksterne kald (streng CSP).
- Aldrig tekstur bag brødtekst. I skrivevinduet står selve skriftfeltet på ren papirfarve; kornet ses kun i
  arkets margener og toner blødt ud (`box-shadow` i papirfarven). Prikgitteret i tomme tilstande toner ud
  mod midten, så teksten altid står på hvid flade.
- `prefers-contrast: more` slår alle teksturer fra. `prefers-reduced-motion` slår overgange fra
  (fremdriftsbjælken og bjælken i Gennemgang).
- Teksturer bærer aldrig betydning. Lamper og skilte er altid symbol + tekst.

Fravalgt: blueprint-gitter (hører til lærerens klasseværelse, ikke elevens), konturlinjer, halftone og
dithering (hero-flader, som appen ikke har), fluted glass, iridescens, linseforvrængning og slørede fotos
(dekoration uden metafor og svære at holde rolige), støj på knapper og kort (ville gøre små tekster urolige).

## Mørkt tema

Elev-appens vinduer har bevidst ikke et mørkt tema (`color-scheme: light`): skrivevinduet er et hvidt ark,
og Word-rammen ligger oven på Word. Frys-/gennemgangsskærmen er mørk af sig selv (den skal læses fra den anden
ende af lokalet), og den har ingen teksturer. Kommer der et mørkt tema senere, skal teksturernes
token-værdier have en mørk variant – de bruges kun via tokens.

## Principper → beslutninger pr. skærm

### Hovedvindue: tilmelding

- **Goal-gradient / mikrotekst:** "Trin 1 af 2" og "Trin 2 af 2" over overskriften. Eleven ved, hvor langt der er.
- **Recognition over recall:** pladsholderen "Vælg en kode (4-6 cifre)" kan nu læses helt (mellemrum mellem
  cifrene kun i selve koden; felterne står under hinanden i det smalle vindue).
- **Von Restorff:** "Næste"/"Tilmeld" er den eneste blå knap. "Tilbage" er et understreget link.

### Hovedvindue: status

- **Von Restorff + default effect:** én blå knap. I en lektion "Skriv i HolyMoly" (fuld bredde). Uden lektion
  "Se afleveringer", når noget mangler. "Skriv i Word" er sekundær.
- **Occam / law of common region:** "Afleveringer" og "Min HolyMoly" er samlet som navigation under en linje,
  altid samme sted. "Du har N afleveringer, der mangler" er et kort med blå kant (Zeigarnik: det uafsluttede).
- Ingen emoji på "Ræk hånden op".

### Hovedvindue: afleveringer

- **Tom tilstand:** prikgitter og næste skridt ("Når din lærer lægger en ud, står den her.").
- **Peak-end rule:** efter "Aflever" forsvinder valgene. Tilbage står en kvittering på papir: "Afleveret",
  dokumentets titel og mærket (grønt mærkat kun med mærke), tidspunktet og "Luk" som eneste (blå) knap.
  Ingen konfetti, ingen animation.

### Skrivevinduet

- **Papirtekstur:** arket er varmt hvidt med fint korn i margenerne; bordet bag er en svag filt.
- **Goal-gradient:** en lille blå fremdriftsbjælke ved "Bevis: N af 100 ord", ved siden af lampen. Den vises kun,
  når "for kort" er det eneste, der mangler (ellers er tallet ligegyldigt). Blå, ikke grøn/rød: det er en vej,
  ikke en karakter. Bjælken er `aria-hidden`; teksten ved siden af er allerede en `role="status"`.
- **Von Restorff:** én blå knap. "Afslut dokument", mens der skrives; bagefter "Gem Word-fil med mærket"
  ("Afslut" skjules). "Slet kladde" træder tilbage som et understreget link.
- **Default effect:** når mærket mangler, er "Skriv videre" den blå knap og har fokus; "Aflever uden mærke" er
  sekundær. Sletning: "Behold kladden" er standard, "Slet kladde" er rød tekst.
- **Mikrotekst:** "Afslut og aflever" i en skrivetime (så "Afslut" ikke er i tvivl). Overskredet frist står som
  tekst ("· overskredet") i stedet for rød (Parkinson's law: tydelig frist uden stressfarve).
- **Peak-end rule:** kvitteringen hedder "Dokumentet er afleveret" / "Dokumentet er afsluttet". Mærket står
  som et stempel på et ark med koden og linket; forklaringen står under. Fokus på "Luk".
- Et afsluttet dokument får en neutral besked (papir) i stedet for den gule advarsel.
- **Zeigarnik:** i "Afleveringer" er "Fortsæt kladde (N ord)" listens blå knap. "Vedhæft" er sekundær.
- **Progressive disclosure:** hjemme-forklaringen står bag "Må skrives hjemme – hvad ser HolyMoly?" i stedet
  for et langt afsnit ved hver aflevering. Visning (tekststørrelse, linjeafstand) var allerede bag én knap.
- Tælleren på "Afleveringer" er blå (ikke rød): et antal, ikke en alarm.

### Word-rammen og muldvarpen

- **Prägnanz:** skiltet er én fyldt form i statusfarven (mørk grøn `#15803d`, mørk rød `#b91c1c`, grå `#4b5563`)
  med et hvidt ✓, ✗ eller ? og en hvid kant. Det kan læses på afstand og oven på ethvert dokument.
- **Similarity:** grøn betyder kun status, så hattebåndet er gråt i stedet for grønt. Boblen viser samme symbol
  som skiltet.
- **Roligere boble:** hvid, tynd kant, blød skygge og en lille spids mod skiltet (i stedet for en tyk farvet kant).
- **Peak-end rule:** "Teksten er gyldig" viser mærket som et stempel på papir. Den grønne tekst har nu AA-kontrast.

### Min HolyMoly

- **Zeigarnik / Von Restorff pr. kort:** hvert dokument viser sit næste skridt som den blå knap:
  "Fortsæt i Word" / "Åbn i HolyMoly" for kladder, "Vedhæft til aflevering" for afsluttede dokumenter,
  der ikke er afleveret. Afleverede dokumenter har ingen blå knap.
- **Similarity:** status står som mærkat med samme form og farver som på afleveringssiden (grøn kun med mærke).
- **Tom tilstand:** prikgitter, "Du har ingen dokumenter endnu." og hvad man gør. Så er "Skriv i …" øverst
  den blå knap.

### Frys og gennemgang

- Ingen emoji (❄ er fjernet). En tynd blå streg over overskriften samler blikket. Gennemgangens bjælke følger
  `prefers-reduced-motion`.

## Tjek

- `npm run a11y` (axe, WCAG 2.1 A/AA) dækker skrivevinduet og hovedvinduet med afleveringssiden.
- Under kalibreringen blev også tilmeldingen, kvitteringerne, afslut-dialogerne, Word-rammen,
  Min HolyMoly og frys-skærmen tjekket med axe – både normalt og med `prefers-contrast: more`.
