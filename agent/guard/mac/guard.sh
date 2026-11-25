#!/bin/bash
# HolyMoly-vagten (macOS). Kører som root via LaunchDaemon (dk.holymoly.guard).
#
#  - Låser browserne: ingen privat browsing/gæster/nye profiler/"sikker DNS"-omgåelse, og
#    tvangsinstallerer HolyMolys browser-del (Chrome/Edge/Brave via managed preferences, Firefox via policies.json).
#  - Taler DIREKTE med HolyMoly-serveren (ikke gennem elev-appen) med en nøgle kun root kan læse.
#    Lektion, blokeringsliste og "luk dette program" kommer fra serveren. Vagten melder hvilke
#    programmer der kører og hvilket program der er forbundet til HolyMoly (falske klienter afsløres).
#  - Under en lektion: blokerer forbudte sider for HELE computeren via /etc/hosts.
#  - Sørger for at elev-appen (LaunchAgent dk.holymoly.agent) er indlæst for den bruger der er logget ind.
#  - Sætter alt på plads igen, hvis nogen piller ved det, og noterer det (læreren ser rød).
#  - Skriver status til guard-status.json (kun root kan ændre den).
#
#   guard.sh            kør for evigt (hvert 5. sekund)
#   guard.sh --once     én runde (bruges i test)
#   guard.sh --no-tray  rør ikke elev-appen (bruges i test)

ONCE=0; NOTRAY=0
for a in "$@"; do
  case "$a" in --once) ONCE=1 ;; --no-tray) NOTRAY=1 ;; esac
done
GUARD_DIR="$(cd "$(dirname "$0")/.." && pwd)"     # …/Contents/Resources/guard
DATA="${HM_DATA:-/Library/Application Support/HolyMoly}"
HOSTS="${HM_HOSTS:-/etc/hosts}"
MANAGED="${HM_MANAGED:-/Library/Managed Preferences}"
AGENT_PLIST="/Library/LaunchAgents/dk.holymoly.agent.plist"
BEGIN='# >>> HolyMoly (styres automatisk under lektioner - ret ikke)'
END='# <<< HolyMoly'
VERSION=1.3.0
APP_DIR="${HM_APP:-/Applications/HolyMoly.app}"
cfg_value() { /usr/bin/plutil -extract "$1" raw -o - "$GUARD_DIR/config.json" 2>/dev/null; }
BUILT_SERVER="$(cfg_value serverUrl)"
SERVER_RE='^(https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?|http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?)$'
# Skolens adresse (sat af IT eller ved første opsætning) ligger i $DATA/server.txt – kun root kan skrive den
load_server() {
  local s; s="$(head -n1 "$DATA/server.txt" 2>/dev/null | tr 'A-Z' 'a-z' | tr -d '\r\n ')"; s="${s%/}"
  if [ -n "$s" ] && printf '%s' "$s" | grep -Eq "$SERVER_RE"; then SERVER="$s"; else SERVER="$BUILT_SERVER"; fi
  [ -n "$HM_SERVER" ] && SERVER="$HM_SERVER"
  SERVER="${SERVER%/}"
}
# Første opsætning: elev-appens ønske bruges KUN, hvis ingen adresse er sat (bagefter kræver det administrator)
apply_server_request() {
  local f="$DATA/requests/server.txt" want
  [ -f "$f" ] || return 0
  want="$(head -n1 "$f" 2>/dev/null | tr 'A-Z' 'a-z' | tr -d '\r\n ')"; want="${want%/}"
  rm -f "$f"
  case "$BUILT_SERVER" in https://*) return 0 ;; esac
  [ -s "$DATA/server.txt" ] && return 0
  printf '%s' "$want" | grep -Eq "$SERVER_RE" || return 0
  printf '%s\n' "$want" > "$DATA/server.txt"; chown root:wheel "$DATA/server.txt"; chmod 644 "$DATA/server.txt"
  load_server
}
load_server
TEAM_ID="$(cfg_value teamId)"
HOST_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
MAX_LESSON_MS=$((6 * 3600 * 1000))
STATE="$DATA/.guard-state"

umask 022
mkdir -p "$DATA/requests" "$STATE"
chown root:wheel "$DATA" "$STATE" 2>/dev/null
chmod 755 "$DATA"; chmod 1777 "$DATA/requests"; chmod 700 "$STATE"

now_ms() { echo $(( $(date +%s) * 1000 )); }
get() { cat "$STATE/$1" 2>/dev/null || echo "$2"; }
put() { printf '%s' "$2" > "$STATE/$1"; }
add_tamper() {
  printf '%s\t%s\n' "$(now_ms)" "$1" >> "$STATE/tamper.log"
  tail -n 20 "$STATE/tamper.log" > "$STATE/tamper.tmp" && mv "$STATE/tamper.tmp" "$STATE/tamper.log"
}
# Bemærkning (logges hos læreren, giver ikke rød): kan ske uden snyd, fx MDM der skriver indstillingerne om
add_note() {
  printf '%s\t%s\n' "$(now_ms)" "$1" >> "$STATE/notes.log"
  tail -n 20 "$STATE/notes.log" > "$STATE/notes.tmp" && mv "$STATE/notes.tmp" "$STATE/notes.log"
}
sha() { shasum -a 256 | cut -d' ' -f1; }

# macOS beskytter "Managed Preferences" mod `defaults write` – derfor skrives plist-filerne direkte.
# set_pref <domæne> <nøgle> <type: integer|bool|string> <værdi>  -> udskriver 1 hvis ændret
set_pref() {
  local f="$MANAGED/$1.plist" cur
  [ -f "$f" ] || /usr/bin/plutil -create xml1 "$f"
  cur=$(/usr/bin/plutil -extract "$2" raw -o - "$f" 2>/dev/null)
  if [ "$cur" != "$4" ]; then
    /usr/bin/plutil -replace "$2" "-$3" "$4" "$f"
    chown root:wheel "$f"; chmod 644 "$f"
    PREFS_TOUCHED=1
    echo 1
  else
    echo 0
  fi
}

set_forcelist() { # <domæne> <værdi>
  local f="$MANAGED/$1.plist" cur
  [ -f "$f" ] || /usr/bin/plutil -create xml1 "$f"
  cur=$(/usr/bin/plutil -extract ExtensionInstallForcelist.0 raw -o - "$f" 2>/dev/null)
  if [ "$cur" != "$2" ]; then
    /usr/bin/plutil -replace ExtensionInstallForcelist -json "[\"$2\"]" "$f"
    chown root:wheel "$f"; chmod 644 "$f"
    PREFS_TOUCHED=1
    echo 1
  else
    echo 0
  fi
}

ext_value() { # <nøgle> fra extensions.json (simpel parsing – filen laves af byggescriptet)
  [ -f "$GUARD_DIR/extensions.json" ] || return
  /usr/bin/plutil -extract "$1" raw -o - "$GUARD_DIR/extensions.json" 2>/dev/null
}

ensure_policies() {
  local c=0 d chrome edge firefox
  mkdir -p "$MANAGED"; chown root:wheel "$MANAGED" 2>/dev/null; chmod 755 "$MANAGED"
  chrome=$(ext_value chrome); edge=$(ext_value edge); firefox=$(ext_value firefox)
  for d in com.google.Chrome com.brave.Browser; do
    c=$((c + $(set_pref $d IncognitoModeAvailability integer 1)))
    c=$((c + $(set_pref $d BrowserGuestModeEnabled bool false)))
    c=$((c + $(set_pref $d BrowserAddPersonEnabled bool false)))
    c=$((c + $(set_pref $d DnsOverHttpsMode string off)))
    [ -n "$chrome" ] && c=$((c + $(set_forcelist $d "$chrome")))
  done
  d=com.microsoft.Edge
  c=$((c + $(set_pref $d InPrivateModeAvailability integer 1)))
  c=$((c + $(set_pref $d BrowserGuestModeEnabled bool false)))
  c=$((c + $(set_pref $d BrowserAddProfileEnabled bool false)))
  c=$((c + $(set_pref $d DnsOverHttpsMode string off)))
  [ -n "$edge" ] && c=$((c + $(set_forcelist $d "$edge")))
  # Firefox: policies.json i hver Firefox-app
  local ff json app dir
  json='{"policies":{"DisablePrivateBrowsing":true,"DNSOverHTTPS":{"Enabled":false,"Locked":true}'
  [ -n "$firefox" ] && json="$json"',"ExtensionSettings":{"udvidelse@holymoly.dk":{"installation_mode":"force_installed","install_url":"'"$firefox"'"}}'
  json="$json"'},"_holymoly":true}'
  for app in /Applications/Firefox*.app; do
    [ -d "$app" ] || continue
    dir="$app/Contents/Resources/distribution"
    if [ "$(cat "$dir/policies.json" 2>/dev/null)" != "$json" ]; then
      mkdir -p "$dir" && printf '%s' "$json" > "$dir/policies.json" && c=$((c + 1))
    fi
  done
  echo $c
}

# ------------------------------------------------------------------ server + nøgle
KEY="$STATE/key.pem"
ensure_key() {
  [ -s "$KEY" ] || { /usr/bin/openssl ecparam -name prime256v1 -genkey -noout -out "$KEY" 2>/dev/null; chmod 600 "$KEY"; }
  [ -s "$KEY" ]
}
clean() { printf '%s' "$1" | tr '\t\r\n=' '    '; }

server_ok() { # kun HTTPS (undtagen test på denne computer)
  case "$SERVER" in https://*) return 0 ;; http://127.0.0.1*|http://localhost*) return 0 ;; *) return 1 ;; esac
}

post() { # <sti> <body-fil> -> skriver svaret til $STATE/resp, returnerer http-status på stdout
  server_ok && ensure_key || { echo 0; return; }
  local sig
  sig=$(/usr/bin/openssl dgst -sha256 -sign "$KEY" "$2" | /usr/bin/openssl base64 -A)
  /usr/bin/curl -sS --max-time 15 -o "$STATE/resp" -w '%{http_code}' -X POST \
    -H 'Content-Type: text/plain; charset=utf-8' -H "X-HM-Sig: $sig" -H 'X-HM-Sig-Format: der' \
    --data-binary @"$2" "$SERVER$1" 2>/dev/null || echo 0
}

# Er programmet (sti) den ægte HolyMoly-app? Rigtig placering + gyldig signatur fra skolens Team ID (hvis sat)
GENUINE_CACHE=""
genuine() {
  case "$1" in "$APP_DIR"/*) ;; *) return 1 ;; esac
  [ -z "$TEAM_ID" ] && return 0
  [ -n "$GENUINE_CACHE" ] && return "$GENUINE_CACHE"
  if /usr/bin/codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"$TEAM_ID\"" "$APP_DIR" 2>/dev/null; then GENUINE_CACHE=0; else GENUINE_CACHE=1; fi
  return "$GENUINE_CACHE"
}

pair_students() {
  local f="$DATA/requests/pair.txt" line sid code pub body st
  [ -f "$f" ] || return
  while IFS= read -r line; do
    case "$line" in pair=*) ;; *) continue ;; esac
    sid=$(printf '%s' "$line" | cut -f1 | cut -d= -f2 | tr -cd '0-9')
    code=$(printf '%s' "$line" | cut -f2 | tr -cd 'A-Za-z0-9_-')
    [ -n "$sid" ] && [ ${#code} -ge 20 ] || continue
    grep -qx "$sid" "$STATE/paired" 2>/dev/null && continue
    ensure_key || continue
    pub=$(/usr/bin/openssl ec -in "$KEY" -pubout -outform DER 2>/dev/null | /usr/bin/openssl base64 -A)
    printf 'v=1\ncode=%s\npub=%s\nos=mac\nhost=%s\nkeystore=file\nguard=%s\n' "$code" "$pub" "$(clean "$(hostname)")" "$VERSION" > "$STATE/body"
    st=$(post /api/guard/pair "$STATE/body")
    if [ "$st" = 200 ]; then echo "$sid" >> "$STATE/paired"
    elif [ "$st" = 409 ]; then add_tamper 'En anden (falsk) vagt er allerede tilknyttet denne elev'; fi
  done < "$f"
}

beat() { # sætter BEAT_OK, BEAT_LESSON, BEAT_UNTIL, BEAT_NEXT; skriver blokeringsliste/kill-liste til filer
  BEAT_OK=0
  [ -s "$STATE/paired" ] || return
  local now seq lesson b st pid path g
  now=$(now_ms)
  seq=$(get seq 0); seq=$((seq + 1)); [ "$seq" -lt "$now" ] && seq=$now; put seq "$seq"
  lesson=0; [ "$(get lesson_until 0)" -gt "$now" ] && lesson=1
  b="$STATE/body"
  {
    echo 'v=1'
    echo "students=$(sort -u "$STATE/paired" | paste -s -d , -)"
    echo "seq=$seq"; echo "ts=$now"; echo 'os=mac'; echo "guard=$VERSION"; echo 'keystore=file'
    echo "hosts=${LAST_HOSTS_OK:-1}"; echo 'policies=1'
    echo "blockhash=$(get blockhash '')"
    [ -f "$STATE/tamper.log" ] && awk -F'\t' -v now="$now" '(now - $1) < 300000 { gsub(/=/, " ", $2); print "tamper=" $1 "\t" $2 }' "$STATE/tamper.log"
    [ -f "$STATE/notes.log" ] && awk -F'\t' -v now="$now" '(now - $1) < 300000 { gsub(/=/, " ", $2); print "note=" $1 "\t" $2 }' "$STATE/notes.log"
    # Overvåger vagten lektionen lige nu? (serveren viser grå "venter på vagten", indtil den gør)
    echo "lesson=$lesson"
    # Den ægte app – og hvem der er forbundet til HolyMoly-serveren (falsk klient?)
    g=0
    for pid in $(pgrep -f "$APP_DIR/Contents/MacOS/HolyMoly" 2>/dev/null); do
      path=$(ps -o comm= -p "$pid" 2>/dev/null)
      genuine "$path" && g=1
    done
    echo "app=$g"
    local host port ip
    host=$(printf '%s' "$SERVER" | sed -E 's#^[a-z]+://##; s#[:/].*$##')
    port=$(printf '%s' "$SERVER" | sed -nE 's#^[a-z]+://[^:/]+:([0-9]+).*#\1#p'); [ -n "$port" ] || { case "$SERVER" in https*) port=443 ;; *) port=80 ;; esac; }
    for ip in $( { [ "$host" = localhost ] && echo 127.0.0.1; dscacheutil -q host -a name "$host" 2>/dev/null | awk '/ip_address/{print $2}'; echo "$host" | grep -E '^[0-9.]+$'; } | sort -u); do
      # Kun forbindelser hvor den ANDEN ende er HolyMoly-serveren
      lsof -nP -iTCP -sTCP:ESTABLISHED -Fpn 2>/dev/null | awk -v t="$ip:$port" '/^p/{pid=substr($0,2)} /^n/{n=split(substr($0,2),a,"->"); if (n==2 && a[2]==t) print pid}' | sort -u | while read -r pid; do
        [ "$pid" = $$ ] && continue
        path=$(ps -o comm= -p "$pid" 2>/dev/null)
        case "$path" in */curl|curl) continue ;; esac
        if genuine "$path"; then printf 'client=%s\t1\t%s\n' "$pid" "$(clean "$path")"; else printf 'client=%s\t0\t%s\n' "$pid" "$(clean "$path")"; fi
      done
    done
    if [ "$lesson" = 1 ]; then
      ps -axo pid=,comm= | while read -r pid path; do
        local app
        app=$(printf '%s' "$path" | sed -nE 's#.*/([^/]+)\.app/Contents/MacOS/.*#\1#p')
        printf 'proc=%s\t%s\t%s\n' "$pid" "$(clean "${path##*/}")" "$(clean "$app")"
      done
    fi
  } > "$b"
  st=$(post /api/guard/beat "$b")
  # Serveren siger præcis hvilke elever der skal parres igen (fx ny kode / ny computer)
  if grep -q '^unpaired=' "$STATE/resp" 2>/dev/null; then
    grep '^unpaired=' "$STATE/resp" | cut -d= -f2 | tr -cd '0-9\n' > "$STATE/unpaired"
    grep -vxF -f "$STATE/unpaired" "$STATE/paired" > "$STATE/paired.tmp"; mv -f "$STATE/paired.tmp" "$STATE/paired"
  elif [ "$st" = 401 ]; then
    REJECTS=$((${REJECTS:-0} + 1)); [ $REJECTS -ge 3 ] && { : > "$STATE/paired"; REJECTS=0; }
  fi
  [ "$st" = 200 ] || return
  REJECTS=0; BEAT_OK=1
  BEAT_LESSON=$(grep -m1 '^lesson=' "$STATE/resp" | cut -d= -f2)
  BEAT_UNTIL=$(grep -m1 '^until=' "$STATE/resp" | cut -d= -f2 | tr -cd 0-9)
  BEAT_NEXT=$(grep -m1 '^next=' "$STATE/resp" | cut -d= -f2 | tr -cd 0-9)
  if grep -q '^block=' "$STATE/resp"; then
    grep '^block=' "$STATE/resp" | cut -d= -f2- | tr 'A-Z' 'a-z' | grep -E "$HOST_RE" | head -n 20000 > "$STATE/lesson_hosts.tmp"
    mv -f "$STATE/lesson_hosts.tmp" "$STATE/lesson_hosts"
    put blockhash "$(grep -m1 '^blockhash=' "$STATE/resp" | cut -d= -f2 | tr -cd 'a-f0-9')"
  fi
  grep '^kill=' "$STATE/resp" | cut -d= -f2 | tr -cd '0-9\n' > "$STATE/kill"
}

current_block() {
  awk -v b="$BEGIN" -v e="$END" '$0==b{f=1;next} $0==e{f=0;next} f' "$HOSTS" 2>/dev/null
}

has_block() { grep -qxF "$BEGIN" "$HOSTS" 2>/dev/null; }

ensure_hosts() { # <aktiv 0/1> -> sætter HOSTS_COUNT og HOSTS_TAMPER
  local active=$1 expected="" cur_hash exp_hash tmp
  HOSTS_COUNT=0; HOSTS_TAMPER=0
  if [ "$active" = 1 ]; then
    expected=$( { grep -E "$HOST_RE" "$GUARD_DIR/baseline-hosts.txt" 2>/dev/null; cat "$STATE/lesson_hosts" 2>/dev/null; } | sort -u | head -n 20000 | sed 's/^/0.0.0.0 /')
    HOSTS_COUNT=$(printf '%s\n' "$expected" | grep -c .)
  fi
  local current
  current=$(current_block)
  if [ "$current" != "$expected" ] || { [ "$active" = 1 ] && ! has_block; } || { [ "$active" = 0 ] && has_block; }; then
    cur_hash=$(printf '%s' "$current" | sha)
    if [ "$active" = 1 ] && [ -n "$(get written_hash '')" ] && [ "$cur_hash" != "$(get written_hash '')" ]; then HOSTS_TAMPER=1; fi
    tmp="$STATE/hosts.new"
    awk -v b="$BEGIN" -v e="$END" '$0==b{f=1;next} $0==e{f=0;next} !f' "$HOSTS" > "$tmp"
    if [ "$active" = 1 ]; then
      { echo "$BEGIN"; printf '%s\n' "$expected"; echo "$END"; } >> "$tmp"
    fi
    chflags nouchg,noschg "$HOSTS" 2>/dev/null
    cat "$tmp" > "$HOSTS" && rm -f "$tmp"
    dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null
    if [ "$active" = 1 ]; then put written_hash "$(printf '%s' "$expected" | sha)"; else put written_hash ''; fi
  fi
}

ensure_tray() { # <aktiv 0/1>
  local uid
  if [ ! -f "$AGENT_PLIST" ] && [ -f "$GUARD_DIR/mac/dk.holymoly.agent.plist" ]; then
    install -m 644 -o root -g wheel "$GUARD_DIR/mac/dk.holymoly.agent.plist" "$AGENT_PLIST"
    add_tamper 'HolyMolys opstartsfil blev slettet - genoprettet'
  fi
  uid=$(stat -f %u /dev/console 2>/dev/null)
  [ -n "$uid" ] && [ "$uid" -gt 0 ] 2>/dev/null || return
  if ! launchctl print "gui/$uid/dk.holymoly.agent" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$uid" "$AGENT_PLIST" 2>/dev/null
    [ "$1" = 1 ] && add_note 'HolyMoly var slået fra under lektionen - startet igen'
  fi
}

write_status() { # <aktiv> <antal>
  local t first=1 ts what
  t='['
  if [ -f "$STATE/tamper.log" ]; then
    while IFS="$(printf '\t')" read -r ts what; do
      [ -n "$ts" ] || continue
      what=$(printf '%s' "$what" | sed 's/\\/\\\\/g; s/"/\\"/g')
      [ $first = 1 ] || t="$t,"
      t="$t{\"ts\":$ts,\"what\":\"$what\"}"; first=0
    done < "$STATE/tamper.log"
  fi
  t="$t]"
  local active=false; [ "$1" = 1 ] && active=true
  printf '{"ts":%s,"version":"%s","lessonUntil":%s,"hostsActive":%s,"hostsCount":%s,"tamper":%s}' \
    "$(now_ms)" "$VERSION" "$(get lesson_until 0)" "$active" "${2:-0}" "$t" > "$DATA/guard-status.json.tmp"
  chmod 644 "$DATA/guard-status.json.tmp"
  mv -f "$DATA/guard-status.json.tmp" "$DATA/guard-status.json"
}

# -----------------------------------------------------------------------------
while :; do
  NOW=$(now_ms)
  CHANGED=$(ensure_policies)
  # Få macOS' indstillingscache til at læse de ændrede filer med det samme
  [ "$CHANGED" -gt 0 ] && killall cfprefsd 2>/dev/null
  if [ "$CHANGED" -gt 0 ] && [ "$(get policies_applied 0)" = 1 ]; then add_note "Browser-indstillinger blev ændret ($CHANGED) - sat på plads igen"; fi
  put policies_applied 1

  # Serveren bestemmer: parring, lektion, blokeringsliste og hvad der skal lukkes
  apply_server_request
  pair_students
  if [ $ONCE = 1 ] || [ "$NOW" -ge "$(get next_beat 0)" ]; then
    WAS_LESSON=0; [ "$(get lesson_until 0)" -gt "$NOW" ] && WAS_LESSON=1
    beat
    if [ "$BEAT_OK" = 1 ] && [ "$BEAT_LESSON" = 1 ] && [ "$WAS_LESSON" = 0 ]; then
      # Lektionen er lige startet: send straks en hjertebanke mere, nu med lektionens data (processer m.m.)
      U=${BEAT_UNTIL:-0}; MAXU=$((NOW + MAX_LESSON_MS)); [ "$U" -gt "$MAXU" ] && U=$MAXU
      put lesson_until "$U"
      beat
    fi
    if [ "$BEAT_OK" = 1 ]; then
      if [ "$BEAT_LESSON" = 1 ]; then
        U=${BEAT_UNTIL:-0}; MAXU=$((NOW + MAX_LESSON_MS)); [ "$U" -gt "$MAXU" ] && U=$MAXU
        put lesson_until "$U"
      else
        put lesson_until 0; put blockhash ''; : > "$STATE/lesson_hosts"   # kun serveren kan afslutte før tid
      fi
      while read -r KPID; do
        [ -n "$KPID" ] || continue
        KNAME=$(ps -o comm= -p "$KPID" 2>/dev/null)
        case "$KNAME" in *HolyMoly*|*/Finder|*/Dock|*/loginwindow|*/WindowServer|*launchd*|"") continue ;; esac
        kill -9 "$KPID" 2>/dev/null
      done < "$STATE/kill" 2>/dev/null
      N=${BEAT_NEXT:-5}; [ "$N" -lt 3 ] && N=3; [ "$N" -gt 60 ] && N=60
      put next_beat $((NOW + N * 1000))
    else
      put next_beat $((NOW + 5000))   # offline: blokeringen fortsætter til lektionens slut
    fi
  fi
  ACTIVE=0; [ "$(get lesson_until 0)" -gt "$NOW" ] && ACTIVE=1
  [ $ACTIVE = 0 ] && : > "$STATE/lesson_hosts"

  ensure_hosts $ACTIVE
  [ "$HOSTS_TAMPER" = 1 ] && add_tamper '/etc/hosts blev ændret under lektionen - sat på plads igen'
  LAST_HOSTS_OK=1; [ "$ACTIVE" = 1 ] && ! has_block && LAST_HOSTS_OK=0

  [ $NOTRAY = 1 ] || ensure_tray $ACTIVE
  write_status $ACTIVE "$HOSTS_COUNT"

  [ $ONCE = 1 ] && break
  sleep 5
done
