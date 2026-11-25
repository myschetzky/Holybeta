# HolyMoly netværksfilter til Mac

Netværksfilteret er en macOS-systemudvidelse (Network Extension, indholdsfilter). Den ser for hver ny forbindelse **hvilket program** der forbinder til **hvilket værtsnavn**. Under en lektion:

- blokerer den AI-tjenester og forbudte sider for **alle programmer**, dvs. Safari, Word, Pages, Python og ukendte apps
- melder AI-forbindelser til elev-appen, så eleven bliver **rød**: "Word bruger AI (copilot.microsoft.com)"
- melder blokerede forsøg i browsere som tekst under elevens navn

Uden for lektionen lukker den alt igennem og registrerer intet. Den kender kun AI- og forbudte værtsnavne og melder kun dem, ikke elevens øvrige trafik.

## Sikkerhed

| Angreb | Hvad sker der |
|---|---|
| Eleven slår filteret fra i Systemindstillinger → Netværk → Filtre | Elev-appen opdager det → **grå** ("Netværksfilteret er ikke slået til") |
| Et andet program forbinder til filteret og prøver at ændre reglerne | Filteret melder ændringen til alle; elev-appen ser at det ikke var den selv → **rød** ("Forsøg på at ændre HolyMoly-netværksfilteret") og gendanner reglerne med det samme |
| Et falsk program lytter på filterets port | Elev-appen tjekker at lytteren kører fra `/Library/SystemExtensions/…/dk.holymoly.filterapp.extension.systemextension/` – ellers afvises den |
| Falske regler uden AI-tjenester | Filteret har en indbygget minimumsliste over AI-tjenester, der altid gælder i en lektion |
| Et program der genbruger HolyMolys proces-id | Programmets identitet slås op ud fra audit-token (inkl. procesversion), aldrig kun proces-id |
| Et program der signerer sig selv som `dk.holymoly.…` (`codesign -i`) | Undtages ikke: kun kode signeret med skolens eget Team ID (`anchor apple generic and certificate leaf[subject.OU] = TEAM_ID`) slipper uden om filteret |
| Et program der bytter filterets regler ud med lige så mange falske | Opdages: filteret sender et fingeraftryk af reglerne ved hver ændring → **rød** |
| Eleven dræber filteret | macOS genstarter selv systemudvidelser; ellers → grå |

## Det skal I bruge (én gang)

1. **Apple Developer Program** (99 $/år) for skolen eller kommunen. Ingen API-regning, kun Apples årlige gebyr.
2. Under *Certificates, Identifiers & Profiles* på developer.apple.com:
   1. **Certifikat**: *Developer ID Application*. Eksportér det som `.p12` med adgangskode.
   2. **App ID** `dk.holymoly.filterapp` med funktionerne *Network Extensions* og *System Extension* og App Group `<TEAM_ID>.dk.holymoly.filterapp`.
   3. **App ID** `dk.holymoly.filterapp.extension` med *Network Extensions* og samme App Group.
   4. **To provisioning profiles** (type *Developer ID*), én til hvert App ID. Når I opretter dem, vælg Network Extension-typen *Content Filter Provider (System Extension)*.
   5. **App-specifik adgangskode** til jeres Apple-ID (appleid.apple.com) til notarisering.

## Byg automatisk (anbefalet)

Læg disse **Secrets** i GitHub (*Settings → Secrets and variables → Actions*):

| Secret | Indhold |
|---|---|
| `CSC_LINK` | `.p12`-certifikatet, base64-kodet (`base64 -i cert.p12`) |
| `CSC_KEY_PASSWORD` | Adgangskoden til `.p12` |
| `MAC_TEAM_ID` | Jeres Team ID (10 tegn) |
| `MAC_SIGN_ID` | Fx `Developer ID Application: Din Skole (ABCDE12345)` |
| `MAC_FILTER_APP_PROFILE` | Profilen til `dk.holymoly.filterapp`, base64-kodet |
| `MAC_FILTER_EXT_PROFILE` | Profilen til `dk.holymoly.filterapp.extension`, base64-kodet |
| `APPLE_ID` | Apple-ID til notarisering |
| `APPLE_APP_SPECIFIC_PASSWORD` | Den app-specifikke adgangskode |

Push et versions-tag (fx `v1.2.0`). GitHub Actions gør så følgende:
1. bygger og signerer filteret
2. lægger det ind i HolyMoly.app
3. slår `requireMacFilter` til
4. signerer og notariserer hele appen

Uden secrets bygges appen uden filter, og Mac-eleverne bruger den hidtidige genkendelse.

## Byg på egen Mac

```bash
TEAM_ID=ABCDE12345 SIGN_ID="Developer ID Application: Din Skole (ABCDE12345)" APP_PROFILE=~/Downloads/HolyMoly_Filter.provisionprofile EXT_PROFILE=~/Downloads/HolyMoly_Filter_Extension.provisionprofile macos/build.sh
```

Uden variabler (`macos/build.sh`) bygges en ad hoc-signeret version, der kun bruges til at tjekke at koden kompilerer. Det sker også automatisk ved hvert push (workflowet *Mac-netværksfilter*).

## Hos eleven

Første gang viser elev-appen punktet **"Slå HolyMoly-netværksfilteret til" [Slå til]**:

1. Eleven trykker **Slå til**.
2. macOS beder om godkendelse. Elev-appen åbner selv *Systemindstillinger → Generelt → Login-emner og udvidelser → Netværksudvidelser*, hvor eleven slår **HolyMoly** til.
3. macOS spørger "HolyMoly vil filtrere netværksindhold". Eleven vælger **Tillad**.

Herefter er filteret slået til permanent. Det gør dog kun noget, når en lektion er i gang.

**På skole-administrerede Macs** (Jamf, Intune, Apple School Manager) kan trin 2 og 3 springes over med en konfigurationsprofil:
- `com.apple.system-extension-policy` med Team ID og `dk.holymoly.filterapp.extension`
- `com.apple.webcontent-filter` med `FilterDataProviderBundleIdentifier = dk.holymoly.filterapp.extension`

## Filer

| Fil | Indhold |
|---|---|
| `Extension/FilterDataProvider.swift` | Selve filteret: værtsnavn → blokér/meld |
| `Extension/ControlServer.swift` | Lokal forbindelse (127.0.0.1:47830) til elev-appen; protokol beskrevet i toppen af filen |
| `Extension/SigningInfo.swift` | Programmets signatur-id ud fra audit-token |
| `Extension/HostMatcher.swift` | Domæne-matching + indbygget AI-minimumsliste |
| `FilterApp/main.swift` | "HolyMoly Filter.app": installerer og slår filteret til (`activate`, `status`, `deactivate`) |
| `build.sh` | Kompilerer (Apple Silicon + Intel), samler og signerer |
| `../agent/src/macfilter.js` | Elev-appens side: forbindelse, verificering, manipulationsdetektion |
