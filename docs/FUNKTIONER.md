# HolyMoly – funktioner og udviklingsplan

Pejlemærker for al videreudvikling. En ny funktion skal opfylde alle fire:

1. **Brugbar**: Løser den et konkret problem i en rigtig lektion?
2. **Lovlig**: Behandler den kun de data, der er nødvendige, og kun i lektionen? (se [JURA.md](JURA.md))
3. **Simpel**: Kan en lærer forstå den uden at læse en manual? Kan eleven ignorere den?
4. **Ingen falske røde lamper**: Rød kræver et hårdt bevis. Har vi ikke et, bliver funktionen ikke bygget sådan.

## Det er bygget (version 1.2)

### Læreren
| Funktion | Hvorfor |
|---|---|
| Klasseværelse som tegning med lamper (grøn/rød/grå) | Overblik på 2 sekunder |
| Under hvert navn: hvad eleven er inde på | Se uden at kigge på skærme |
| Klik på elev → live-skærm i stor størrelse | Kun når læreren aktivt vælger det |
| Tag skærmbillede (gemmes med tid og adresse) | Dokumentation ved mistanke |
| Frys én / alle skærme med besked | "Kig op på tavlen" |
| Gennemgang: alle skærme på standby med ur, dato og tid tilbage af lektionen | Alle kigger op – og ved hvor længe der er igen |
| **Skriv i HolyMoly**: Word-agtig editor i elev-appen; indsæt og træk-og-slip er blokeret; skriveforløbet måles | Skriftlige opgaver, der er tastet i HolyMoly uden indsat tekst |
| **Skrive-bevis**: signeret bevis (Ed25519) når teksten er tastet under overvågning, uden rød lampe, i menneskeligt tempo og uden ordrette AI-fraser; alle kan tjekke det på /bevis/… | Dokumentation over for censor, forældre og klagesager |
| Elevens dokumenter i elevskuffen (fanen Dokumenter) med begrundelse, hvis der ikke er bevis; hent som Word | Læreren ser teksten og forløbet ét sted |
| **Afspil skriveforløbet**: skyder/afspil gennem versionerne (hver ~20 sek.), det nye fremhævet | Se hvordan teksten blev til – stærkere end et gæt |
| **Ligner andre afleveringer**: lokalt tjek af fælles 5-ords-sætningsdele mellem klassens dokumenter (info, aldrig rød) | Opdager afskrift mellem elever – lokalt, uden eksterne tjenester |
| **Ræk hånden op ✋**: knap i elev-appen; ✋ på bordet og i toppen; læreren tager hånden ned | Hjælp uden at råbe – også for de stille elever |
| **Lektionens links**: læreren lægger links ind før timen; eleverne åbner dem med ét klik i appen; advarsel + "Tillad" hvis et link er blokeret | Ingen links der skal sendes ud i timen |
| **Lektionsrapport**: minutter grøn/rød/grå pr. elev (tidslinje), årsager, fund, forsøg, ✋ og afleveringer; åbner når lektionen slutter; CSV | Overblik og opfølgning uden at grave i logs |
| **Afleveringer**: læreren opretter en aflevering (opgave, frist); eleven vedhæfter et dokument skrevet i HolyMoly; læreren ser status og fluebenet og henter Word | Hele skriveopgaven ét sted |
| **✓ Tastet i HolyMoly – intet indsat i Word-filen** (med "i timen" eller "hjemme uden opsyn"): skrivebeskyttet .docx med flueben, kode og tjek-link i sidefoden | Et enkelt mærke på filen – ingen "belønning" |
| **Kontoer**: opret konto med e-mail (bekræftes), glemt adgangskode, slet konto; **to-faktor** med godkendelses-app + reservekoder; Unilogin (STIL's loginvælger: Unilogin/MitID/lokalt login) | Sikker adgang til elevdata uden ekstra udgifter |
| **Skoler og licens**: 30 dages prøveperiode, skole-administrator inviterer kolleger, bestil licens med CVR/EAN, `/admin` aktiverer licenser | HolyMoly kan sælges som licens til skoler |
| **Forside med priser**, vilkår, privatlivspolitik, databehandleraftale og hent-side; animationer der respekterer "reducer bevægelse" | Skolerne kan selv finde, prøve og købe HolyMoly |
| Web-log, kørende programmer, hændelser | Fuld historik for lektionen |
| Bloker / tillad et program med ét klik | Nye spil og værktøjer lukkes hurtigt |
| Egne blokerede og tilladte sider pr. klasse | Fx tillad YouTube i musik |
| Prøvetilstand: kun tilladte sider | Til prøver i timen (ikke eksamen i beta) |
| Start/afslut lektion, stopper automatisk | Ingen overvågning uden for timen |
| Klassekode: eleverne tilmelder sig selv og dukker op med det samme; kan fornyes og lukkes | Ingen lister at taste ind |
| Login: vælg Lærer eller Elev, UNI-Login (OpenID Connect via STIL) eller e-mail | Ingen ekstra adgangskode; elevens navn kommer fra UNI-Login |
| Velkomst første gang + i-knap med vejledning og farvernes betydning | Ingen manual nødvendig |
| Lyst tema som standard, mørkt under Indstillinger | Til projektor og mørke lokaler |
| Lærer-logbog: "Mette så skærmen live 10.32" | Ansvarlighed over for elever og forældre |
| Eksportér elevens log (CSV, beskyttet mod formel-injektion) | Indsigtsret og klagesager |

### Eleven
| Funktion | Hvorfor |
|---|---|
| Lille vindue: navn + "Forbundet" | Intet at forstå eller rode med |
| Tjekliste hvis noget mangler (opdatering, udvidelse, Mac-tilladelser) med én knap pr. punkt | Eleven kan selv gøre sig klar |
| Lægger sig selv i proceslinjen/menulinjen | Forstyrrer ikke |
| Besked når læreren kigger med / tager skærmbillede | Gennemsigtighed (lovkrav) |
| Kan ikke afsluttes under lektionen | Kun "på" eller "ikke på" |

### Genkendelse og blokering (lokalt på elevens computer – ingen API'er, ingen regning)
| Funktion | Platform |
|---|---|
| ~600 domæner: AI, sociale medier, spil, video, lektiehjælp, proxy, fjernstyring | Alle |
| Browser-udvidelse til Chrome, Edge, Brave, Opera, Vivaldi **og Firefox** | Alle |
| Omgåelse via Google Translate-proxy, arkiver, base64, "unblocked games" | Alle |
| Kopier af sider genkendt på indholdet (to uafhængige beviser) | Chrome/Edge/Brave |
| AI-knapper i tilladte sider skjules (Gemini i Docs/Gmail, Copilot i Word Online …) | Chrome/Edge/Brave |
| Google AI-oversigter og AI-tilstand slået fra | Chrome/Edge/Brave |
| Adressen læses fra browseren selv (også inkognito, andre profiler, skærm 2) | Windows, Mac |
| Alle faner i Safari/Chrome tjekkes, forbudte sendes til blokeringsside | Mac |
| Browsere uden udvidelse og vinduer der ikke kan ses ind i, lukkes | Windows, Mac |
| **Programmer der taler med AI-tjenester** (Word med Copilot, Python mod OpenAI, ukendte AI-apps) | Windows (DNS-cache), Mac (netværksfilter) |
| **Mac-netværksfilter**: blokerer AI og forbudte sider for alle programmer inkl. Safari; manipulation giver rød | Mac |
| Apple Intelligence / Skriveværktøjer-vinduer | Mac |
| Omdøbte programmer genkendes (originalt filnavn / bundle-id) | Windows, Mac |
| Spil, AI-apps, Discord, fjernstyring og virtuelle maskiner lukkes automatisk | Alle |
| Regellister opdateres centralt uden ny installation | Alle |

### Sikkerhed
- Elevens app: ingen debugging, filerne kan ikke ændres (Electron-fuses + asar-integritet), serveradressen kan ikke ændres, kræver HTTPS.
- Server: scrypt-adgangskoder, rate-limit, engangskoder, lærere ser kun egne klasser, streng CSP.
- Minimumsversion af app og udvidelse: for gamle versioner får ingen lektion (grå "Skal opdatere").

## Idékatalog (prioriteret)

Hver idé er vurderet efter de fire pejlemærker øverst. ★ = anbefalet som det næste.

### Undervisningen
| | Idé | Gevinst | Indsats |
|---|---|---|---|
| ✓ | **Opgaver** – bygget som *Afleveringer* (se ovenfor) | | |
| ★ | **Prøve med nedtælling**: prøvetilstand + tid; afleveres automatisk, når tiden er gået | Skriftlige prøver uden papir | Lille |
| ★ | **Besked til én elev eller hele klassen** (uden at fryse skærmen) – fx "Husk at gemme" | Ro i klassen | Lille |
| ★ | **Fag-profiler**: færdige regelsæt pr. fag (Matematik: GeoGebra/WordMat, Musik: YouTube, Sprog: ordbøger) | Rigtige regler med ét klik | Lille |
| | **Skema-start**: lektioner starter efter skemaet (Lectio/Aula-kalender som .ics) – læreren bekræfter | Ingen glemte "Start lektion" | Mellem |
| | **Exit-spørgsmål**: ét spørgsmål til sidst i timen ("Hvad var svært i dag?"); svarene samles hos læreren | Hurtig evaluering | Lille |
| | **Grupper**: grupper på klasse-tegningen; gruppens medlemmer må samarbejde i delte dokumenter | Gruppearbejde uden falske "ligner hinanden" | Mellem |
| | **Vis lærerens skærm** på elevernes skærme under Gennemgang | Alle ser det samme | Stor |

### Ærlighed og skrivning
| | Idé | Gevinst | Indsats |
|---|---|---|---|
| ★ | **Kilder og citater i Skriv**: eleven indsætter et citat *med kilde* (markeret som citat); beviset viser, hvor meget der er citeret | Citater er lovlige – nu også i beviset | Mellem |
| | **Aflever direkte til Lectio/Teams** med beviset vedhæftet | Ét sted at aflevere | Mellem (kræver adgang til deres API) |
| | **Skrive-bevis i Word**: tilføjelsesprogram, så eleven kan skrive i rigtig Word med samme måling | Velkendt værktøj | Stor |

### Drift, sikkerhed og jura
| | Idé | Gevinst | Indsats |
|---|---|---|---|
| ★ | **Elevens indsigt**: eleven ser sin egen log og rapport i appen/på hjemmesiden (GDPR-indsigtsret) | Gennemsigtighed – færre klager | Lille |
| ★ | **IT-panel**: hvilke computere mangler vagten, en opdatering eller en tilladelse | IT kan rydde op før timen | Lille |
| | **Skole-administrator**: opret lærere, fælles regelsæt, statistik | Drift på hele skolen | Mellem |
| | **MDM-pakker** (Intune/Jamf) + **TPM-attestering** af vagten | Lukker den sidste sprække (falsk vagt) | Mellem/stor |
| | **Microsoft/Google-login** ud over UNI-Login | Ingen ekstra adgangskode | Lille/mellem |
| | **Signér Mac-filteret og Windows-installeren** (Apple Developer, kodesigneringscertifikat) | Ingen advarsler hos eleverne | Lille (kræver konti) |
| | **Udgiv browser-udvidelsen** (Chrome/Edge/Firefox – kan være "unlisted") | Én-klik-installation | Lille |
| | **Test på rigtige maskiner** i en prøvelektion (1 Windows-PC + 1 MacBook) | Bekræfter alt Windows/Mac-specifikt | Lille |

### Bygges ikke (bevidst)
- **Overvågning uden for lektionen** eller automatisk start med computeren i elevens fritid.
- **Skærmbilleder på bordene** uden at læreren har klikket.
- **Gætte-lamper** (gul/"måske"): enten bekræftet, eller ikke på.
- **AI-baseret genkendelse via betalte API'er**: alt sker lokalt med regler.
- **Tastetryk-logning** eller adgang til elevens filer: ikke nødvendigt, ikke proportionalt.
