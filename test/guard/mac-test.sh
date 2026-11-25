#!/bin/bash
# Tester HolyMoly-vagten på en rigtig Mac (GitHub Actions, sudo) mod en rigtig HolyMoly-server.
FAILED=0
check() { if eval "$1"; then echo "  OK   $2"; else echo "  FEJL $2"; FAILED=$((FAILED + 1)); fi; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
G="$ROOT/agent/guard"
DATA="/Library/Application Support/HolyMoly"
MP="/Library/Managed Preferences"
export HM_SERVER="http://127.0.0.1:18080"
# Testinstallation af "HolyMoly.app": binærfilen er en kopi af node, så den simulerede elev-app kører fra den rigtige sti
export HM_APP="/tmp/HolyMolyTest.app"
mkdir -p "$HM_APP/Contents/MacOS" && cp "$(command -v node)" "$HM_APP/Contents/MacOS/HolyMoly"
guard() { bash "$G/mac/guard.sh" --once --no-tray; }
view() { curl -s http://127.0.0.1:18081/view; }
pref() { plutil -extract "$2" raw -o - "$MP/$1.plist" 2>/dev/null; }
cat > /tmp/forced.swift <<'SWIFT'
import Foundation
let a = CommandLine.arguments
print(CFPreferencesAppValueIsForced(a[2] as CFString, a[1] as CFString) ? "forced" : "not-forced")
SWIFT
forced() { xcrun swift /tmp/forced.swift "$1" "$2" 2>/dev/null; }
printf '{"chrome":"abcdefghijklmnopabcdefghijklmnop;https://clients2.google.com/service/update2/crx","edge":"","firefox":""}' > "$G/extensions.json"

echo "Server + elev-app + lektion (harness)"
mkdir -p "$DATA/requests"; chmod 1777 "$DATA/requests"
node "$ROOT/test/guard/harness.js" "$DATA" "macOS 15" "$HM_APP/Contents/MacOS/HolyMoly" &
HARNESS=$!
sleep 5
check 'view | grep -q "ikke tilknyttet"' "uden vagt: aldrig grøn ($(view | head -c 200))"

echo "Vagten parrer sig og taler direkte med serveren"
guard; sleep 1.5
check 'view | grep -q "\"guard\":\"ok\""' 'serveren har modtaget en gyldig, signeret hjertebanke'
check 'view | grep -q "\"color\":\"green\""' "eleven er grøn med vagt ($(view | head -c 300))"
check '[ "$(stat -f %Lp "$DATA/.guard-state/key.pem")" = 600 ] && [ "$(stat -f %Su "$DATA/.guard-state/key.pem")" = root ]' 'vagtens nøgle kan kun læses af root'

echo "Browser-låsning"
check '[ "$(pref com.google.Chrome IncognitoModeAvailability)" = 1 ]' 'Chrome: inkognito slået fra'
check '[ "$(pref com.microsoft.Edge InPrivateModeAvailability)" = 1 ]' 'Edge: InPrivate slået fra'
check '[ "$(pref com.google.Chrome DnsOverHttpsMode)" = off ]' 'Chrome: sikker DNS-omgåelse slået fra'
check 'pref com.google.Chrome ExtensionInstallForcelist.0 | grep -q abcdef' 'Chrome: browser-delen tvangsinstalleres'
check '[ "$(forced com.google.Chrome IncognitoModeAvailability)" = forced ]' "macOS: Chrome-indstillingen er påtvunget [$(forced com.google.Chrome IncognitoModeAvailability)]"
check '[ "$(forced com.microsoft.Edge InPrivateModeAvailability)" = forced ]' 'macOS: Edge-indstillingen er påtvunget'

echo "Blokering for hele computeren – listen kommer fra serveren"
guard
check 'grep -qx "0.0.0.0 chatgpt.com" /etc/hosts' 'chatgpt.com blokeres'
check 'grep -qx "0.0.0.0 example-blocked-site.com" /etc/hosts' 'lærerens egen blokering (fra serveren) virker'
check 'dscacheutil -q host -a name chatgpt.com | grep -q "0.0.0.0"' 'chatgpt.com slås op til 0.0.0.0'
printf 'until=0\n' > "$DATA/requests/lesson.txt"; guard
check 'grep -qx "0.0.0.0 chatgpt.com" /etc/hosts' 'eleven kan ikke afslutte blokeringen (kun serveren kan)'

echo "Forbudt program lukkes af vagten (besked fra serveren)"
cp /bin/sleep /tmp/RobloxPlayerBeta
/tmp/RobloxPlayerBeta 300 &
GAME=$!
sleep 1; guard; sleep 1
check '! kill -0 $GAME 2>/dev/null' 'spillet blev lukket af vagten'

echo "Falsk HolyMoly-klient (et program der selv taler med serveren)"
(sleep 60 | nc 127.0.0.1 18080 >/dev/null) &
FAKE=$!
sleep 2; guard; sleep 1.5
check 'view | grep -q "Falsk HolyMoly-klient"' "falsk klient afsløret: $(view | grep -o '"violations":\[[^]]*\]' | head -c 300)"
pkill -f "nc 127.0.0.1 18080" 2>/dev/null; kill $FAKE 2>/dev/null

echo "Manipulation"
awk '!/HolyMoly/ && !/^0\.0\.0\.0 /' /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts
plutil -remove IncognitoModeAvailability "$MP/com.google.Chrome.plist"
guard; guard; sleep 1.5
check 'grep -qx "0.0.0.0 chatgpt.com" /etc/hosts' 'hosts-blokeringen er sat på plads igen'
check '[ "$(pref com.google.Chrome IncognitoModeAvailability)" = 1 ]' 'browser-låsningen er sat på plads igen'
check 'view | grep -q "slå HolyMoly fra"' "læreren ser manipulationen som rød"

echo "Kun serveren kan afslutte lektionen"
curl -s -X POST http://127.0.0.1:18081/stop >/dev/null
guard
check '! grep -q HolyMoly /etc/hosts' 'blokeringen fjernes når læreren afslutter lektionen'

echo "LaunchDaemon"
sed "s#/Applications/HolyMoly.app/Contents/Resources/guard/mac/guard.sh#$G/mac/guard.sh#" "$G/mac/dk.holymoly.guard.plist" > /Library/LaunchDaemons/dk.holymoly.guard.plist
chown root:wheel /Library/LaunchDaemons/dk.holymoly.guard.plist; chmod 644 /Library/LaunchDaemons/dk.holymoly.guard.plist
launchctl bootstrap system /Library/LaunchDaemons/dk.holymoly.guard.plist
sleep 4
check 'launchctl print system/dk.holymoly.guard | grep -q "state = running"' 'vagten kører som root via launchd'
PID=$(launchctl print system/dk.holymoly.guard | awk '/pid =/{print $3; exit}')
kill -9 "$PID" 2>/dev/null; sleep 8
check 'launchctl print system/dk.holymoly.guard | grep -q "state = running"' 'macOS genstarter vagten når den dræbes'

echo "Afinstallation"
kill $HARNESS 2>/dev/null; pkill -f fake-tray.js 2>/dev/null
bash "$G/mac/uninstall.sh"
check '! launchctl print system/dk.holymoly.guard >/dev/null 2>&1' 'vagten er stoppet og fjernet'
check '[ -z "$(pref com.google.Chrome IncognitoModeAvailability)" ]' 'browser-låsningen er fjernet'
check '[ ! -d "$DATA" ]' 'vagtens mappe er fjernet'

git -C "$ROOT" checkout -- agent/guard/extensions.json 2>/dev/null
[ $FAILED = 0 ] && echo "Alle Mac-vagttest bestået" || { echo "$FAILED fejl"; exit 1; }
