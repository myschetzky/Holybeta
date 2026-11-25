#!/bin/sh
# Opdatér HolyMoly på serveren (Docker). Kør fra hvor som helst:
#
#   scripts/opdater.sh           henter ny kode, bygger og genstarter – men kun, når ingen lektioner eller skriveøkter er i gang
#   scripts/opdater.sh --force   genstarter alligevel
#
# Ved genstart får eleverne besked i skrivevinduet ("HolyMoly-serveren genstarter. Skriv bare videre"),
# og skriveøkterne fortsætter, når serveren er oppe igen. Med Cloudflare Tunnel: sæt
#   COMPOSE="docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.cloudflare.yml"
set -eu
cd "$(dirname "$0")/.."
COMPOSE="${COMPOSE:-docker compose -f deploy/docker-compose.yml}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

git pull --ff-only
# Byg først: serveren kører videre, mens det nye billede bygges
$COMPOSE build holymoly
if [ "$FORCE" = 0 ]; then
  # Tjekket kører i det nye billede (kun læsning af databasen), ved siden af den kørende server
  if ! $COMPOSE run --rm --no-deps -T holymoly node --disable-warning=ExperimentalWarning /app/scripts/enkel.js aktive; then
    echo "Ikke genstartet. Prøv igen efter timen, eller kør: scripts/opdater.sh --force"
    exit 1
  fi
fi
$COMPOSE up -d holymoly
echo "HolyMoly er opdateret."
