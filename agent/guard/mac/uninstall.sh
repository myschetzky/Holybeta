#!/bin/bash
# Fjerner HolyMoly-vagten og alt den har sat (køres som root).
HOSTS="${HM_HOSTS:-/etc/hosts}"
MANAGED="${HM_MANAGED:-/Library/Managed Preferences}"
DATA="${HM_DATA:-/Library/Application Support/HolyMoly}"
BEGIN='# >>> HolyMoly (styres automatisk under lektioner - ret ikke)'
END='# <<< HolyMoly'
uid=$(stat -f %u /dev/console 2>/dev/null)
[ -n "$uid" ] && [ "$uid" -gt 0 ] 2>/dev/null && launchctl bootout "gui/$uid/dk.holymoly.agent" 2>/dev/null
launchctl bootout system/dk.holymoly.guard 2>/dev/null
rm -f /Library/LaunchDaemons/dk.holymoly.guard.plist /Library/LaunchAgents/dk.holymoly.agent.plist
if grep -qxF "$BEGIN" "$HOSTS" 2>/dev/null; then
  awk -v b="$BEGIN" -v e="$END" '$0==b{f=1;next} $0==e{f=0;next} !f' "$HOSTS" > /tmp/hm.hosts.$$ && cat /tmp/hm.hosts.$$ > "$HOSTS" && rm -f /tmp/hm.hosts.$$
  dscacheutil -flushcache 2>/dev/null; killall -HUP mDNSResponder 2>/dev/null
fi
for d in com.google.Chrome com.brave.Browser com.microsoft.Edge; do
  for k in IncognitoModeAvailability InPrivateModeAvailability BrowserGuestModeEnabled BrowserAddPersonEnabled BrowserAddProfileEnabled DnsOverHttpsMode ExtensionInstallForcelist; do
    /usr/bin/plutil -remove "$k" "$MANAGED/$d.plist" >/dev/null 2>&1
  done
done
for app in /Applications/Firefox*.app; do
  f="$app/Contents/Resources/distribution/policies.json"
  grep -q '"_holymoly":true' "$f" 2>/dev/null && rm -f "$f"
done
killall cfprefsd 2>/dev/null
rm -rf "$DATA"
exit 0
