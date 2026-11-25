# Skole-administrerede computere (anbefalet til prøver)

På computere skolen administrerer (Intune, Google Admin, Jamf), kan udvidelsen tvangsinstalleres,
så eleven ikke kan slå den fra, og inkognito/gæsteprofiler kan slås fra. Det lukker de største huller.

## Chrome / Edge (Windows, via GPO eller Intune)
- `ExtensionInstallForcelist`: `<udvidelses-id>;https://clients2.google.com/service/update2/crx`
  (Edge: `https://edge.microsoft.com/extensionwebstorebase/v1/crx`)
- `IncognitoModeAvailability` = 1 (Chrome) / `InPrivateModeAvailability` = 1 (Edge) – slår inkognito fra
- `BrowserGuestModeEnabled` = 0, `BrowserAddPersonEnabled` = 0 – ingen ekstra profiler
- `DeveloperToolsAvailability` = 2 – ingen udviklerværktøjer

## Chromebooks (Google Admin)
Enheder → Chrome → Apps og udvidelser → Brugere og browsere → tilføj udvidelsen som "Tving installation".

## Mac (Jamf / profil)
Samme Chrome-politikker via en konfigurationsprofil (`com.google.Chrome`), og en PPPC-profil der
giver HolyMoly adgang til skærmoptagelse og hjælpefunktioner, så eleven ikke skal godkende det.
