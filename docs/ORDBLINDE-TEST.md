# Testplan: ordblinde-programmer og diktering i skrivevinduet

Skal køres af udvikleren sammen med en lærer, **før der kommer rigtige elever**. Det tager ca. en time.
Uden testen ved vi ikke, om en ordblind elev kan skrive i HolyMoly uden at blive afvist eller mistænkt.

## Hvorfor

Skrivevinduet afviser tekst, der ikke er tastet. Ordblinde-programmer sætter hele ord ind (ordforslag),
og diktering sætter hele sætninger ind. Uden hjælpemidler slår det til som "indsat tekst".
Med hjælpemidler (læreren sætter dem i elevdialogen) skal det virke sådan:

| Hjælpemiddel | Hvad skrivevinduet tillader | Tælles i | Betydning for mærket |
|---|---|---|---|
| Ordforslag | Ét ord ad gangen, højst 30 tegn, højst ét ord pr. 700 ms, og kun når det fuldender et ord, eleven er begyndt på | `stats.predicted` | Ingen. Byger, hurtige tastetryk og jævnhed bliver noter. |
| Diktering | Én diktering (IME `compositionend`) på højst 300 tegn ad gangen | `stats.dictated` | Over 10 % dikteret tekst giver ikke mærket. Eleven ser "Diktering kan ikke bevises som tastet. Aflever alligevel – du får ingen ulempe." |

Uden hjælpemidler ser eleven: "Det kunne ikke sættes ind her. Bruger du et ordblinde-program eller diktering, så sig det til din lærer."

## Opsætning

- En rigtig Windows 11-pc (skolens image, hvis muligt) med HolyMoly-appen og HolyMoly-vagten. En Mac til Mac-diktering.
- 2-3 elever, gerne mindst én, der bruger programmet til daglig. Læreren er med hele tiden.
- En testklasse på testserveren. Én elev uden hjælpemidler, én med "Ordforslag", én med "Ordforslag" og "Diktering".
- Programmerne i den version, skolen bruger: AppWriter (Windows og Chrome-udvidelsen), IntoWords (Windows og Chrome-udvidelsen) og CD-ORD.

## Fremgangsmåde for hvert program

1. Start en lektion. Tjek at lampen er grøn **før** programmet startes, og igen efter.
2. Åbn skrivevinduet og tryk "Øv dig" (øvedokumentet sendes ikke). Skriv et par sætninger med programmet.
3. Prøv **oplæsning** af det, der står i skrivevinduet.
4. Prøv **ordforslag**: skriv starten af et ord, og vælg et forslag med mus og med tastatur.
5. Prøv **diktering**, hvis programmet har det.
6. Gentag 2-5 i et rigtigt dokument, og aflever. Se prøve-vurderingen og lærerens noter i dashboardet.
7. Skriv resultatet i matrixen. Notér ordret, hvad der stod i en evt. besked.

## Matrix

Udfyld med **ja / nej / delvist** og en kort note. "Lukket af politik?" betyder: blokerer HolyMoly programmet, eller bliver lampen rød eller grå?

| Program | Lukket af politik? | Oplæsning | Ordforslag | Diktering | Note |
|---|---|---|---|---|---|
| AppWriter (Windows) | | | | | |
| AppWriter (Chrome-udvidelse) | | | | – | Virker den i skrivevinduet, eller kun i Chrome? |
| IntoWords (Windows) | | | | | |
| IntoWords (Chrome-udvidelse) | | | | – | Virker den i skrivevinduet, eller kun i Chrome? |
| CD-ORD | | | | | |
| Windows-diktering (Win+H) | | – | – | | Kommer teksten som én diktering eller som `insertText`? |
| Mac-diktering (Fn Fn) | | – | – | | |

## Det skal vi især se efter

- **Rollback**: forsvinder teksten igen lige efter, den er sat ind? Så tæller skrivevinduet den ikke som et hjælpemiddel. Notér, om programmet sætter ord ind med tilbage-tast + helt ord, med markering + helt ord eller kun med resten af ordet.
- **Diktering i flere bidder**: Win+H kan sende teksten som `insertText` i stedet for IME-komposition. Så afvises den. Det skal i givet fald rettes i `agent/renderer/write.js`.
- **Markøren**: står markøren samme sted efter en afvist indsættelse?
- **Lampen**: bliver den rød eller grå, når programmet starter eller læser op? Rød koster kun mærket ved AI, fjernstyring, virtuel maskine og proxy/VPN.
- **AI-funktioner**: har programmet en AI-funktion (fx omskrivning eller "skriv for mig")? Den må ikke kunne skrive teksten for eleven. Notér, om den kan slås fra.
- **Stavekontrol og visning**: virker højreklik med forslag, A−/A+, Luftig og Ctrl +/- sammen med programmet?
- **Tempo**: får eleven med ordforslag en tempo-grund (det må ikke ske) eller kun en note?
- **Mærket og Word-filen**: nævner de et hjælpemiddel? (Det må de ikke.)

## Når testen er kørt

- Ret det, der ikke virker, før der kommer rigtige elever. Skriv en test for hver rettelse i `test/`.
- Gem den udfyldte matrix her i filen med dato, Windows-version og programversioner.
- Fortæl læreren, hvilke programmer der virker, og at hjælpemidlerne sættes i elevdialogen ("Hjælpemidler: Ordforslag / Diktering").

Kørt: _dato, hvem, Windows-version, programversioner_
