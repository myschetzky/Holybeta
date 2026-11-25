# HolyMoly – juridisk tjekliste (databeskyttelse)

Dette er en praktisk tjekliste, ikke juridisk rådgivning. Gennemgå den med skolens databeskyttelsesrådgiver (DPO), før HolyMoly tages i brug.

## Hvorfor det er relevant
HolyMoly behandler personoplysninger om elever – ofte under 18 år: hvilke sider og programmer de bruger, skærmbilleder og tidspunkter. Det er omfattet af databeskyttelsesforordningen (GDPR) og databeskyttelsesloven. Systematisk overvågning af børn og unge kræver, at skolen kan dokumentere, at behandlingen er **nødvendig, proportional og gennemsigtig**.

## Før start – skolens ansvar
| ✔ | Krav | Hvordan HolyMoly hjælper |
|---|---|---|
| ☐ | **Behandlingsgrundlag** (typisk GDPR art. 6, stk. 1, litra e: opgave i samfundets interesse – undervisning og afvikling af prøver). Samtykke er normalt ikke et egnet grundlag i et skole-elev-forhold. | – |
| ☐ | **Formål** skrevet ned: fx "sikre at eleverne kun bruger tilladte hjælpemidler i undervisning og prøver" | Systemet kan kun bruges i lektioner |
| ☐ | **Konsekvensanalyse (DPIA)**: systematisk overvågning af børn/unge kræver som udgangspunkt en DPIA (art. 35) | Dataminimering og opbevaringsfrist er indbygget |
| ☐ | **Databehandleraftale** med den, der hoster serveren (art. 28), hvis det ikke er skolen selv | Server kan køre på skolens egen maskine |
| ☐ | **Information til elever og forældre** (art. 13) – hvad registreres, hvornår, hvor længe, hvem ser det | Tekst nedenfor kan bruges |
| ☐ | **Ordensregler / IT-regler** opdateret: appen skal være åben i lektioner, hvad sker der ved rød/grå | – |
| ☐ | **Opbevaringsfrist** besluttet (standard 30 dage) | `LOG_RETENTION_DAYS` – sletter automatisk |
| ☐ | **Adgangsstyring**: kun lærere med behov | Lærere ser kun egne klasser; skolekode til oprettelse |
| ☐ | **Indsigtsret** (art. 15): rutine for at udlevere en elevs log | Klik på eleven → **Eksportér log** |

## Indbygget i HolyMoly (privacy by design)
- **Kun i lektionen**: intet registreres, før læreren trykker "Start lektion", og alt stopper automatisk ved lektionens slut.
- **Vagt og app**: HolyMoly-vagten kører som systemtjeneste (SYSTEM på Windows, root på Mac), og appen starter med computeren. Den overvåger først i en lektion eller i elevens egen skriveøkt. Browser-udvidelsen og browserpolitikkerne er installeret hele tiden – det skal stå i konsekvensanalysen (det arbejdes på at fjerne dem uden for lektioner).
- **Skærmen ses kun ved klik**: ingen billeder på bordene. Eleven får besked, når læreren kigger med eller tager et skærmbillede. Automatiske skærmbilleder ved forbudt brug er slået fra som standard; slår læreren dem til for klassen, får eleven besked hver gang.
- **Lærer-logbog**: hvem så skærmen, tog skærmbillede eller frøs – med navn og tid.
- **Ingen keylogger, ingen filer, ingen mikrofon/kamera.** I HolyMolys eget skrivevindue tælles kun skrivestatistik til mærket "✓ Tastet i HolyMoly – intet indsat" (antal anslag, tastede/slettede tegn, tempo og rytme, forsøg på at indsætte, tid uden for vinduet) – ikke hvilke taster. Rytme og tempo minder om tastedynamik og bør nævnes i konsekvensanalysen.
- **Mac-netværksfilteret** kender kun listen over AI- og forbudte værtsnavne og melder kun forbindelser til dem – ikke elevens øvrige trafik – og kun i lektionen.
- **Eksport af elevens log** (CSV) til brug ved indsigtsanmodninger og klagesager; eksporten står i lærer-logbogen.
- **Automatisk sletning** efter opbevaringsfristen. Sletter man en elev eller klasse, slettes al dens log og alle skærmbilleder.
- **Ingen tredjeparts-API'er og ingen analyse i skyen.** Bruges en Cloudflare-tunnel eller en hostingudbyder, er de underdatabehandlere og skal stå i databehandleraftalens bilag B.
- **Elevens egen computer**: Skolen kræver HolyMoly i undervisningen, så installationen er ikke frivillig – men appen overvåger kun i en lektion, læreren har startet, og i elevens egne skriveøkter, og den kan fjernes uden for skoletid.

## Forslag til information til elever og forældre
> **HolyMoly i undervisningen**
>
> I [klasse/fag] bruger vi HolyMoly for at sikre, at alle arbejder på lige vilkår uden adgang til AI, sociale medier og spil i timerne og til prøver.
>
> **Hvornår?** Kun når læreren har startet en lektion, og HolyMoly er åben på computeren. Uden for lektionerne registreres intet.
>
> **Hvad registreres?** Navnet på det program og den hjemmeside, der er fremme, åbne faner, kørende programmer, og om forbudte sider eller programmer bliver brugt eller blokeret. Læreren kan se skærmen live og tage skærmbilleder – eleven får besked hver gang.
>
> **Hvad registreres ikke?** Hvad eleven taster i andre programmer, filer, mikrofon, kamera og private beskeder uden for lektionen. Når eleven skriver i HolyMolys eget skrivevindue, tælles kun tempo, rytme og antal anslag (ikke hvilke taster) – det bruges til fluebenet "Tastet i HolyMoly – intet indsat".
>
> **Hvor længe?** Oplysningerne slettes automatisk efter [30] dage.
>
> **Hvem ser det?** Kun klassens lærer(e). Data opbevares på [skolens server / databehandler].
>
> **Dine rettigheder:** Du kan få indsigt i de oplysninger, vi har om dig, og klage til Datatilsynet. Kontakt [DPO, e-mail].
