# Skriv i Word

Eleven kan vælge at skrive i det normale Word i stedet for i HolyMolys eget skrivevindue. Word får en blå HolyMoly-kant, en smal HolyMoly-bjælke øverst og en muldvarp nederst til højre. Muldvarpen holder et skilt, der viser, om teksten holder:

| Skilt | Betyder |
|---|---|
| Grøn ✓ | "Grøn – teksten tæller med" |
| Rød ✗ | Teksten kan ikke få mærket lige nu, fx "Rød: der er kommet tekst, som ikke er tastet, kl. 10.14" eller "Rød: tekst indsat fra et andet program kl. 10.14" |
| Grå ? | HolyMoly kan ikke afgøre det, fx ingen forbindelse, ingen lektion, "Words AI (Copilot) er slået til – bruger du den, får teksten ikke mærket" eller "HolyMoly kan ikke se, om Word's AI (Copilot) er slået fra" |

Klik på muldvarpen viser årsagen i en boble. Skærmlæsere får den samme tekst (aria-live).

Når eleven er færdig, trykker hun på **Tekst færdig** i bjælken:

- **Teksten er gyldig:** Word gemmer dokumentet. Serveren vurderer teksten og udsteder beviset (som i dag). Word forsegler derefter dokumentet: mærket, koden og tjek-linket kommer i sidefoden, og dokumentet bliver læsebeskyttet. Det gemmes som `Dokumenter/HolyMoly/{titel} – forseglet.docx`, Word-dokumentet lukkes, og dokumentet står i **Min HolyMoly**.
- **Teksten er ikke gyldig:** årsagerne vises med valget **Skriv videre** eller **Gem uden mærke**.

Dokumentet gemmes altid af Word. HolyMoly bekræfter kun.

Mærket siger kun det, HolyMoly har målt:

- Med talte tastetryk (tastetælleren kørte i hele dokumentet, og tastetrykkene forklarer teksten): `✓ Tastet i Word via HolyMoly – intet indsat · i timen` (eller `· hjemme, uden opsyn`). Beviset har `observed: ['word', 'taster']`.
- Uden talte tastetryk (ingen tæller, fx blokeret af antivirus, eller et dokument fra en ældre app): `✓ Skrevet i Word via HolyMoly – tekstvækst målt`. HolyMoly så kun, hvordan teksten voksede. Beviset har `observed: ['word']`.

Uden HolyMoly-vagten står der også `· kun Word`, og fra en testserver `· TESTSERVER`. Tjek-siden skriver, at Word er et lavere niveau end skrivevinduet.

## Slået fra i enkel tilstand (BETA_FEATURES=word)

"Skriv i Word" er **slået fra** i enkel tilstand (beta), indtil hele den manuelle testplan nedenfor er kørt på 2-3 af skolens egne Windows-maskiner. Så længe det er fra:

- viser elev-appen ikke "Skriv i Word" (hverken i hovedvinduet, i Min HolyMoly eller i skrivevinduet),
- bruger "Skriv verificeret aflevering" HolyMolys skrivevindue,
- afviser serveren Word-gemninger og Word-afleveringer (`source: 'word'`) med "Skriv i Word er slået fra på skolens server. Brug skrivevinduet."

Slå det til med `BETA_FEATURES=word` (sammen med andre funktioner: `BETA_FEATURES=word,liveScreen`) og genstart serveren. Se docs/ENKEL.md. I den fulde udgave (koncept) er det slået til.

## Sådan virker det

```
Word (COM)  <-- JSON-linjer -->  word.ps1 (PowerShell)  <-->  bridge.js  <-->  keys.js  <-- JSON-linjer -->  keys.ps1 (tastetæller)
                                                               |
             overlay.js + word-frame.*  <--  manager.js  -->  session.js (skiltet), clipboard.js
                                                |
                                     serveren: 'doc' / 'doc-submit' med source: 'word'
                                                |
                                     seal.js: sidefod, forsegling, tjek af den forseglede fil
```

| Fil | Hvad |
|---|---|
| `agent/src/word/word.ps1` | PowerShell styrer Word via COM. Svarer på `probe`, `open`, `state`, `save`, `seal`, `close`. Læser Copilot-politikkerne i registret. Giver Word-vinduets `hwnd` til tastetælleren. |
| `agent/src/word/keys.ps1`, `agent/src/word/keys.js` | Tastetælleren: en lavniveau-tastaturhook i sin egen PowerShell-proces, kun mens en Word-økt er åben (se "Tastetryk i Word"). |
| `agent/src/word/bridge.js` | Starter PowerShell (word.ps1 sendes som første linje på stdin, så det virker fra `app.asar`). Kun ASCII på ledningen. Uden for Windows: `{ supported: false }`. |
| `agent/src/word/bridge-fake.js` | En falsk Word med samme protokol (i samme proces eller som underproces). Bruges i testene og i demoen. Skriver .docx-filer, der ligner Words egne. Kan simulere tastetællerne (`fake:type`, `fake:paste`, `fake:insert`, `fake:inject`, `fake:delete`, `fake:keys`) og er med `--keys` en falsk tastetæller. |
| `agent/src/word/session.js` | Tekst-tjekket: afgør skiltet ud fra tekstens snapshots ca. hvert sekund. |
| `agent/src/word/clipboard.js` | Tømmer udklipsholderen, når den har tekst fra et andet program, og Word er i forgrunden. |
| `agent/src/word/manager.js` | Økten: Word, tjekket, rammen, serveren og "Tekst færdig". |
| `agent/src/word/seal.js` | Sidefodens linjer (samme tekster som `toDocx`), teksten fra den gemte .docx og tjek af den forseglede fil. |
| `agent/src/word/overlay.js`, `agent/renderer/word-frame.*` | Rammen: gennemsigtigt vindue uden ramme, altid øverst, der følger Word-vinduet. |
| `agent/src/word/mine*.js`, `agent/renderer/word-mine.*` | Min HolyMoly. |
| `agent/src/word/app.js`, `agent/renderer/word-writer.js` | Kobler det hele til Electron, hovedvinduet og skrivevinduet. |

### Tastetryk i Word

Mens en Word-økt er åben, tæller elev-appen tastetryk i Word – ved siden af, mens Word også får tasterne. Det er det samme, som skrivevinduet tæller, men i Word:

- **Hvordan:** `keys.ps1` installerer en lavniveau-tastaturhook (`SetWindowsHookEx(WH_KEYBOARD_LL)`) med sin egen beskedløkke på sin egen tråd. Hooken kalder altid `CallNextHookEx`, så Word (og alle andre programmer) får hver tast uændret. Den blokerer intet og ændrer intet.
- **Hvornår:** Tælleren startes, når en Word-økt åbner, og stoppes, når den slutter (Word-dokumentet lukkes, forsegles, gemmes uden mærke, eller HolyMoly lukker). Den tæller kun, når netop det Word-vindue, broen styrer (`hwnd` fra `word.ps1`), er i forgrunden. Taster i andre programmer – og i Words egne dialoger som *Søg og erstat* – tælles ikke.
- **Hvad:** Aldrig hvilke taster. Tasten bruges kun i det øjeblik, den trykkes, til at finde en kategori, og glemmes straks. Det, der tælles, er:

| Felt | Hvad |
|---|---|
| `typed`, `keystrokes` | Tegn-taster: bogstaver, tal, tegn, mellemrum, Enter og Tab (også AltGr-tegn som @ og €). En tast, der holdes nede, tæller højst 32 tegn. |
| `deleted` | Backspace og Delete (også Ctrl+Backspace/Delete). |
| `pasteKeys` | Ctrl+V, Ctrl+Shift+V og Shift+Insert. |
| `undo` | Ctrl+Z, Ctrl+Y og Alt+Backspace. |
| `injected` | Taster sendt af et program (`LLKHF_INJECTED`, fx en autotyper eller makro). De tæller ikke som tastet. |
| `maxCps`, `burst`, `fastShare`, `regularity` | Tempoet – samme definitioner som skrivevinduet (`agent/renderer/write.js`): tegn pr. sek. over 5 sek., tegn inden for ét sekund, andel tastetryk under 12 ms og variationskoefficienten for afstanden mellem tastetryk. Kun tidspunkter, aldrig taster. |

- **Hvorfor sin egen proces:** En tastaturhook i PowerShell ligner teknisk en keylogger. Stopper antivirus eller EDR den, stopper kun tællingen – ikke Word-broen.
- **Ingen tastetæller:** Kan hooken ikke installeres (andet end Windows, PowerShell i Constrained Language Mode, antivirus …), svarer broen `keys: null`. Så gælder reglerne fra før (uden tastestatistik), og muldvarpen har noten "Tastetryk kan ikke tælles på denne computer". Copilot slået til giver så stadig afslag. Er tastetryk ikke talt i hele dokumentet (fx en tidligere økt uden tæller), vurderes hele dokumentet uden.
- **Til serveren:** `stats` med Word-gemningerne får `keys: true` og tallene ovenfor plus `restored` (tekst, der har stået i dokumentet før og kom igen: fortryd, kopi og flyt af egen tekst) og `untyped` (antal gange muldvarpen så tekst, som tastetrykkene ikke kan forklare). Tallene lægges oven i dokumentets tidligere økter (gemt i elev-appen), så serveren altid har tallene for hele dokumentet.

### Tekst-tjekket (muldvarpens skilt)

- **Tekst, der ikke er tastet (med tastetryk):** Ny tekst – tegn i ord, der ikke har stået i dokumentet før, og mellemrummene mellem dem – skal kunne forklares af tegn-tasterne. Margenen er den samme som serverens: max(20 tegn, 3 % af teksten) til autokorrektur og autoformat. Tekst, der har stået i dokumentet før, må komme igen uden tastetryk (fortryd/gendan, kopi og flyt af egen tekst), da fortryd ikke kan tælles præcist. Er der mere ny tekst, end tastetrykkene kan forklare, bliver muldvarpen rød med det samme: "Rød: der er kommet tekst, som ikke er tastet, kl. 10.14" (eller "… indsat med Ctrl+V …", hvis Ctrl+V blev brugt). Det fanger indsat tekst, Copilot, Diktér, autotekst og en autotyper – også når teksten kommer i små bidder. Det er permanent for dokumentet. Tællerne læses efter teksten; hooken tæller en tast, før Word får den, så tællerne er aldrig bagud.
- **Tekst indsat udefra:** teksten vokser i ét spring med mere sammenhængende ny tekst, end et menneske kan skrive: over 60 tegn på under 2 sekunder (ved længere tid mellem to målinger: 15 tegn pr. sekund). Tekst, der allerede har stået i dokumentet, er tilladt: eleven må kopiere, flytte og fortryde sin egen tekst. Det afgøres med tre-ords-sekvenser fra alle de tekster, økten har set. Et spring er permanent for dokumentet (serveren har set teksten).
- **AI-spor:** de ordrette chatbot-fraser fra `shared/doc.js` (`aiTraces`).
- **Copilot:** Med tastetryk: `on` = grå "Words AI (Copilot) er slået til – bruger du den, får teksten ikke mærket" (og en note, hvis skiltet er rødt af en anden grund). Det er ikke et afslag: bruger eleven Copilot, fanges det af tastetjekket. `unknown` = grå, `off` = intet. Uden tastetryk som før: `on` = rød, `unknown` = grå, `off` = intet.
- **Serveren:** ingen lektion eller forbindelse = grå. Elevens egen lampe (`my-lamp`) og serverens prøve-vurdering tæller med.
- **Genåbnet dokument:** er der kommet ny tekst til, siden HolyMoly sidst så dokumentet, er skiltet rødt ("dokumentet er ændret uden for HolyMoly").

### Udklipsholderen

Mens en Word-økt er åben, og Word (eller HolyMolys ramme) er i forgrunden, tømmes udklipsholderen, når den har indhold fra et andet program end Word. Det tjekkes hvert 500 ms. Electron kan ikke se, hvilket program der kopierede, så reglen er: tekst, der har stået i dokumentet, er fra Word. Kort tekst (højst 60 tegn), der er kopieret, mens Word var i forgrunden, er også fra Word. Alt andet er fra et andet program. Uden for Word røres udklipsholderen ikke. Serveren får kun antallet af gange (en note til læreren).

### Serveren

Word-økten sender tekst-snapshots som almindelige `doc`-gemninger med `source: 'word'` (blokke = afsnit). Derfor gælder serverens vækstbudget, grå/rød-reglerne, AI-fraserne og beviset præcis som i dag. For `source: 'word'`:

- **Med tastetryk (`stats.keys: true`):** `typed − deleted + restored + max(20, 3 %) < tekstens længde` eller `untyped > 0` giver kategorien `indsat` med teksten "Der er kommet tekst i Word, som ikke er tastet (fx indsat, Copilot, diktering eller autotekst)". Er Ctrl+V brugt samtidig, får læreren også den grund. Over 20 injicerede taster giver `tempo` ("Taster sendt af et program"). Tempo-tjekkene (`maxCps`, `burst`, `fastShare`, `regularity`) er de samme som i skrivevinduet; med diktering er `burst`, `fastShare`, `regularity` og injicerede taster kun noter; med ordforslag kun `burst`. `copilot: 'on'` er kun en note. Beviset siger "Teksten passer med tastetrykkene i Word".
- **Uden tastetryk (`keys: false` eller intet felt):** tastetryk-tjekkene springes over, `copilot: 'on'` giver afslag, og læreren får noten "Tastetryk kan ikke tælles på denne computer".
- Appen melder altid `pasteInserted` (spring udefra), `pasteBlocked` (udklipsholderen tømt), `focusLostMs` og `copilot`. `'unknown'` er en note til læreren.
- `observed` bliver `['word']` (+ `'vagt'`), og `checks` i beviset siger "Skrevet i Word gennem HolyMoly".
- Et dokument kan ikke skifte mellem skrivevinduet og Word.

### Forseglingen og tjek-siden

Ved "Tekst færdig" læses teksten fra den .docx, Word lige har gemt (ikke fra Word direkte). Det er den, der afleveres og hashes, og det er den samme brødtekst, tjek-siden læser i den forseglede fil. Sidefoden ligger i `word/footer1.xml` og er ikke brødtekst. Efter forseglingen læser appen selv den forseglede fil og tjekker, at den giver samme sha256 som beviset. Passer den, slettes kladden, og den forseglede fil er dokumentet.

## Begrænsninger

- **Kun Windows** i første version. Word til Mac kan styres med AppleScript, men det er ikke bygget.
- **Tastetryk tælles kun på Windows og kun med tastetælleren.** Uden den (se "Tastetryk i Word") ser HolyMoly kun, hvordan teksten vokser. Et program, der sender taster som rigtige tastetryk (fx en hardware-autotyper), kan ikke skelnes fra et menneske. Det står allerede i forbeholdet på mærket.
- **Taster i Copilot-ruden tæller med.** Ruden ligger i Word-vinduet, så det, eleven taster til Copilot, tæller som tastet. Copilots svar kan derfor "betales" med lige så mange tastetryk i ruden. Det er kun muligt med Copilot slået til; derfor er det stadig bedst, at skolens IT slår Copilot fra.
- **Words tekstforslag (Text Predictions, accepteres med Tab) og autotekst** giver tekst uden tastetryk og kan gøre muldvarpen rød. Slå "Vis tekstforslag, mens du skriver" fra (*Filer > Indstillinger > Avanceret*).
- **Erstat alle** (Søg og erstat) med længere ord kan i en kort tekst give mere ny tekst end margenen. Taster i Words dialoger tælles ikke.
- **Skærmtastatur og hjælpeprogrammer, der sender taster** (fx ordforslag i et ordblindeprogram) tæller som injicerede taster: tekst fra dem er ikke tastet, og over 20 taster giver `tempo` (med diktering kun en note). Har eleven brug for dem, skal eleven bruge HolyMolys skrivevindue med hjælpemidler.
- **Antivirus/EDR:** En lavniveau-tastaturhook fra PowerShell er præcis det, mange antivirusprogrammer leder efter hos keyloggere. Microsoft Defender (AMSI) eller en EDR kan stoppe `keys.ps1` eller advare om den. Så stopper kun tællingen (noten "Tastetryk kan ikke tælles på denne computer"). Skolens IT kan tillade den; HolyMoly skjuler den ikke.
- **Copilot skal stadig helst slås fra af skolens IT.** HolyMoly kan ikke slå Copilot fra. Med tastetryk fanges brug af Copilot af tastetjekket; uden tastetryk giver Copilot slået til afslag. Se politikkerne nedenfor.
- **Words egen diktering ("Diktér") og "Omskriv"-forslag (Editor/Copilot):** diktering giver tekst uden tastetryk og gør muldvarpen rød. Begge er forbundne oplevelser, der analyserer indhold, og slås fra med samme politik som Copilot (`usercontentdisabled = 2`).
- **Office-udklipsholderen** (ruden med 24 elementer i Word) er Words egen. Den tømmes ikke. Indsætter eleven derfra, ses det som et spring.
- **Tekstbokse, figurer og sporede ændringer:** tekst i tekstbokse kan få tjekket af den forseglede fil til at fejle. Sporede ændringer slås fra, når HolyMoly åbner dokumentet. Fejler tjekket, får eleven besked, og tjek-linket i sidefoden virker stadig.
- **Læsebeskyttelsen** (`Protect(wdAllowOnlyReading)` med en tilfældig adgangskode, som ingen kender) kan fjernes af en, der redigerer filen direkte. Om teksten er ændret, afgøres altid på tjek-siden.
- **Skriveøkt hjemme:** startes den i skrivevinduet og i Word på samme tid til samme aflevering, slutter den, når den første af dem lukkes.
- **Flere skærme og skalering:** rammen omregner Words fysiske pixels til Electrons koordinater (`screen.screenToDipRect`). Det er ikke afprøvet på skærme med forskellig skalering.

## Copilot: politikkerne til skolens IT

HolyMoly læser disse værdier under `HKEY_CURRENT_USER\Software\Policies\Microsoft\office\16.0\common\privacy` (og samme sti under `HKEY_LOCAL_MACHINE`). De sættes med Group Policy (*User Configuration\Policies\Administrative Templates\Microsoft Office 2016\Privacy\Trust Center*), Cloud Policy eller Intune.

| Politik | Registerværdi | For at slå Copilot fra | Bekræftet |
|---|---|---|---|
| Allow the use of connected experiences in Office that analyze content | `usercontentdisabled` | `2` (Disabled) | Ja. Microsoft skriver, at Copilot så ikke kan bruges i Word, Excel, PowerPoint, Outlook og OneNote. Slår også Diktér, Editor-forslag og Oversæt fra. |
| Allow the use of connected experiences in Office | `disconnectedstate` | `2` (Disabled) | Ja. Slår næsten alle forbundne oplevelser fra (også samtidig redigering og OneDrive i Office). Kun hvis skolen ønsker det. |
| Allow the use of additional optional connected experiences in Office | `controllerconnectedservicesenabled` | `2` (Disabled) | Ja. Slår valgfrie Copilot-funktioner fra, fx websøgning. Er ikke nok alene. |

Sådan tolker HolyMoly værdierne:

- `off`: `usercontentdisabled = 2` eller `disconnectedstate = 2`.
- `on`: `usercontentdisabled = 1` (IT har udtrykkeligt tilladt oplevelser, der analyserer indhold). **Usikker:** Copilot kræver også, at eleven har adgang til Copilot.
- `off`: Office LTSC 2019/2021/2024 (volumenlicens, `ProductReleaseIds` under `HKLM\SOFTWARE\Microsoft\Office\ClickToRun\Configuration`). **Usikker:** LTSC har ikke Copilot ifølge vores viden, men det er ikke afprøvet.
- Ellers `unknown` (grå muldvarp).

Word 2412 og nyere har også et afkrydsningsfelt *Filer > Indstillinger > Copilot > Aktivér Copilot* pr. app og pr. computer. HolyMoly læser det ikke (vi har ikke fundet en dokumenteret registerværdi for det).

Kilder: [Microsoft: Use policy settings to manage privacy controls for Microsoft 365 Apps](https://learn.microsoft.com/en-us/microsoft-365-apps/privacy/manage-privacy-controls), [Microsoft: Data, Privacy, and Security for Microsoft Copilot (afsnittet om privacy controls for connected experiences)](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy).

## Udvikling og test

- `npm test` kører alt, der kan testes på Linux: `test/word-session.test.js` (skiltet, tastetjekket og udklipsholderen), `test/word-bridge.test.js` (protokollen med den falske Word og den falske tastetæller som underprocesser, forseglingen, tjek-siden med en Word-lignende .docx og et statisk tjek af hooken i `keys.ps1`), `test/word-server.test.js` (`source: 'word'` i serveren), `test/word-manager.test.js` (hele økten mod en rigtig server), `test/word-frame.test.js` og `test/word-mine.test.js` (rammen og Min HolyMoly tegnet i Chromium, skærmbilleder i `test-results/`), `test/word-app.test.js` (knapperne og koblingen til Electron), `test/word-graenser.test.js` (grænserne: til serveren går kun samlede tal pr. snapshot – aldrig tastekoder eller tid pr. tast – tælleren kører kun under en Word-økt med Word-vinduet i forgrunden, og skrivelogens uddrag er kun dokumentets egen tekst) og `test/word-flag.test.js` (serverflaget og mærket).
- Demo uden Word: `HOLYMOLY_WORD_FAKE=1 npm run agent` (kun i en app, der ikke er pakket). Rammen og muldvarpen vises over et tænkt Word-vindue øverst til venstre.
- `word.ps1` og `keys.ps1` er **ikke kørt** – der er hverken Windows, PowerShell eller Word i udviklingsmiljøet. De er kun tjekket statisk. For `keys.ps1` tjekker testen, at hooken altid kalder `CallNextHookEx`, at der kun tælles, når Word-vinduet er i forgrunden, at tasten kun bruges til kategorien og aldrig gemmes eller sendes, og at kun tællerne sendes.

## Manuel testplan (Windows-pc med Word)

Forberedelse: Windows 10/11 med Microsoft 365 Word (og helst en med Office LTSC). HolyMoly-appen installeret, eleven tilmeldt en klasse, læreren har startet en lektion.

1. **Valget:** Hovedvinduet viser "Skriv i HolyMoly", "Skriv i Word" og "Min HolyMoly". På en pc uden Word vises "Skriv i Word" ikke.
2. **Start:** "Skriv i Word" åbner Word med et nyt dokument, der allerede er gemt i `Dokumenter\HolyMoly`. Den blå kant sidder præcis om Word-vinduet, bjælken står øverst i midten, og muldvarpen nederst til højre over statuslinjen.
3. **Følg vinduet:** Flyt, maksimér, gendan og minimér Word. Rammen følger med inden for et sekund og forsvinder, når Word er minimeret eller et andet program er fremme. Prøv på to skærme og med 125 %/150 % skalering.
4. **Klik igennem:** Skriv, markér og brug båndet i Word overalt, også tæt på kanten. Klik kommer igennem, undtagen på bjælken og muldvarpen.
5. **Grøn:** Med Copilot slået fra (`usercontentdisabled = 2`) og grøn lampe er skiltet grønt, mens du skriver.
6. **Grå:** Uden politikken er skiltet gråt med Copilot-teksten. Træk netværkskablet: gråt "Ingen forbindelse".
7. **Indsat tekst:** Kopiér et afsnit fra en hjemmeside, skift til Word: udklipsholderen er tom (Ctrl+V gør intet). Kopiér i Word og sæt ind: virker. Indsæt fremmed tekst via *Indsæt > Objekt > Tekst fra fil*: skiltet bliver rødt med klokkeslæt.
8. **Flyt egen tekst:** Klip et langt afsnit og sæt det ind et andet sted, også et minut senere. Fortryd en stor sletning (Ctrl+Z). Skiltet forbliver grønt.
9. **Copilot:** Sæt `usercontentdisabled = 1`, genstart Word: skiltet bliver gråt med Copilot-noten (rødt, hvis tastetryk ikke kan tælles). Prøv "Diktér" med politikken = 2: knappen er grå. Se også trin 24.
10. **Gem:** Ctrl+S i Word opdaterer "Gemt kl." i bjælken. Uden at gemme: Word gemmer selv efter et minut.
11. **Tekst færdig – gyldig:** Skriv mindst 100 ord, tryk "Tekst færdig". Word lukker, `{titel} – forseglet.docx` findes, sidefoden viser mærket, HM-koden og tjek-linket, og dokumentet kan ikke redigeres. Upload filen på tjek-siden: "Teksten passer til beviset". Kladden er væk.
12. **Tekst færdig – ikke gyldig:** Efter trin 7: årsagerne vises med "Skriv videre" og "Gem uden mærke". "Gem uden mærke" gemmer og lukker dokumentet uden mærke.
13. **Min HolyMoly:** Begge dokumenter står der med rigtig status. "Åbn mappe" åbner Stifinder med filen markeret. "Vedhæft til aflevering" afleverer, og læreren ser mærket.
14. **Afleveringer og skrivetime:** I skrivevinduets afleveringsliste og under skrivetimens banner står "Skriv i Word". Dokumentet får afleveringens titel og vedhæftes automatisk efter "Tekst færdig".
15. **Hjemme:** En aflevering, der må skrives hjemme: "Skriv i Word" uden lektion starter en skriveøkt (læreren ser "Skriver hjemme"). Luk Word: skriveøkten slutter, og dokumentet står som påbegyndt i Min HolyMoly. "Fortsæt i Word" åbner det igen med grønt skilt.
16. **Ændret uden for HolyMoly:** Åbn kladden i Word uden HolyMoly, skriv et afsnit, gem. "Fortsæt i Word": skiltet er rødt ("ændret uden for HolyMoly").
17. **Word har en dialog åben** (fx Skrifttype): skiltet bliver gråt ("kan ikke læse dokumentet") og grønt igen, når dialogen lukkes.
18. **Luk HolyMoly** midt i en økt (uden for lektion): Word og dokumentet forbliver åbne.
19. **Tastetælleren kører kun under økten:** I Jobliste er der en ekstra `powershell.exe`, mens Word-økten er åben, og den forsvinder, når dokumentet lukkes eller forsegles.
20. **Tastetryk tælles:** Skriv 300 tegn i Word. Skiltet er grønt. Læreren kan se `typed` i dokumentets tal (GET `/api/docs/<id>`, `facts.typed`): ca. 300. Skriv i Notesblok imens: tallet ændrer sig ikke. Skriv i *Søg og erstat*: tallet ændrer sig ikke.
21. **Tegn:** Æ, ø, å, AltGr-tegn (@, €, {), accenter (é med ´ + e), taltastaturet og en streg holdt nede (-----): skiltet forbliver grønt.
22. **Ctrl+V:** Kopiér og sæt dit eget afsnit ind (grønt). Sæt fremmed tekst ind fra Office-udklipsholderen: "Rød: tekst indsat med Ctrl+V, som ikke er tastet".
23. **Fortryd:** Slet et langt afsnit med Backspace holdt nede, og fortryd med Ctrl+Z: skiltet forbliver grønt. Aflever: beviset udstedes.
24. **Copilot:** Med `usercontentdisabled = 1` er skiltet gråt med "Words AI (Copilot) er slået til – bruger du den, får teksten ikke mærket". Skriv et afsnit selv og aflever: beviset udstedes. Bed Copilot skrive et afsnit i dokumentet: skiltet bliver rødt inden for et sekund, og serveren afviser med "Der er kommet tekst i Word, som ikke er tastet …". Prøv også Diktér og tekstforslag (Tab).
25. **Autotyper:** Lad et program (fx AutoHotkey `SendInput`) skrive et afsnit i Word: rødt, og serveren afviser med `indsat` og `tempo` ("Taster sendt af et program").
26. **Antivirus/EDR:** Med Microsoft Defender (og skolens EDR, hvis der er en) slået til: virker tællingen, eller kommer noten "Tastetryk kan ikke tælles på denne computer"? Virker Word-broen under alle omstændigheder? Notér, hvad antivirus melder.
27. **Ingen tæller:** Stop den ekstra `powershell.exe` i Jobliste midt i en økt: noten "Tastetryk kan ikke tælles på denne computer" kommer, og Copilot slået til bliver rødt igen (de gamle regler).
28. **Tilgængelighed:** Tab til muldvarpen og "Tekst færdig" i rammen, når den har fokus. Skærmlæseren (NVDA/Oplæser) læser skiltets tekst, når den skifter.
