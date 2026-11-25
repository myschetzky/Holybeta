# HolyMoly beta på egen Proxmox-server

GitHub Pages viser hjemmesiden og demoen. Selve HolyMoly-serveren (login, klasser, elevernes app) kører her, på en container, der altid er tændt.

> **Før rigtige elever:** Serveren og signeringsnøglen (`proof-key.pem`) skal drives af skolen – en VM, som skolens IT har root på. Den, der driver serveren, kan læse alle elevdata og lave beviser. En elev må ikke have den adgang til klassekammeraternes data. Indtil skolen driver den, er det en **testserver**: brug kun testklasser eller frivillige med forældrenes viden, og sæt ikke `SCHOOL_OPERATED=1`. Så står der "Testserver – må ikke bruges til bedømmelse" på beviserne.
>
> Lektioner kan først startes, når skolens ja er udfyldt: `DATAANSVARLIG`, `DPO_KONTAKT`, `DPIA_DATO` og `LEDELSE_JA_DATO` i `deploy/.env` (se docs/ENKEL.md).

Elev-appen kræver **https** og en fast adresse. Vælg én af to veje:

| | B. Åbne porte + Caddy (anbefalet) | A. Cloudflare-tunnel |
| --- | --- | --- |
| Kræver | En offentlig IP og et domæne (eget eller gratis DuckDNS) | Et domæne på Cloudflare (gratis konto) |
| Porte i routeren | 80 og 443 sendes til containeren | Ingen |
| Certifikat | Caddy henter det selv | Cloudflare |
| Data | Går direkte til serveren | Går gennem Cloudflare. Cloudflare er så underdatabehandler og skal stå i databehandleraftalens bilag B og i privatlivspolitikken. |

Brug aldrig en midlertidig `trycloudflare.com`-adresse med rigtige elever – adressen skifter, og beviserne peger på den.

## 1. Container i Proxmox

1. *Create CT*: Debian 12-skabelon, 2 kerner, 2 GB RAM, 16 GB disk. Fast IP, fx `192.168.1.50/24`.
2. *Options → Features*: slå **nesting** og **keyctl** til (kræves af Docker i en container).
3. *Options → Start at boot*: **Yes**.
4. Start containeren og log ind som root.

Giver Docker problemer i containeren, så brug en lille Debian-VM i stedet. Resten er det samme.

## 2. Docker og HolyMoly

```bash
apt update && apt install -y git curl ca-certificates
```

```bash
curl -fsSL https://get.docker.com | sh
```

```bash
git clone -b beta https://github.com/myschetzky/HolyMoly.git /opt/holymoly
```

`beta`-grenen starter selv i enkel tilstand (`server/edition.json`).

## 3. Indstillinger

Opret `/opt/holymoly/deploy/.env`:

```
PUBLIC_URL=https://holymoly.dit-domæne.dk
# A. Cloudflare-tunnel:
CLOUDFLARE_TUNNEL_TOKEN=
# B. Caddy:
HM_DOMAIN=holymoly.dit-domæne.dk
```

Filen indeholder hemmeligheder og må aldrig committes.

## 4A. Cloudflare-tunnel

1. Cloudflare → *Zero Trust → Networks → Tunnels → Create a tunnel* (type *Cloudflared*). Kopiér tokenet ind i `.env`.
2. *Public hostname*: `holymoly.dit-domæne.dk` → service `http://holymoly:8080`.
3. Start:

```bash
cd /opt/holymoly && docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.cloudflare.yml up -d --build holymoly cloudflared
```

## 4B. Åbne porte + Caddy

1. Routeren: send port 80 og 443 (TCP) til containerens IP.
2. DNS: `holymoly.dit-domæne.dk` peger på din offentlige IP (DuckDNS: opret et subdomæne og brug det som domæne).
3. Start:

```bash
cd /opt/holymoly && docker compose -f deploy/docker-compose.yml up -d --build
```

## 5. Tjek at det virker

Åbn `https://holymoly.dit-domæne.dk`, opret en lærer, lav en klasse. Installér elev-appen på en computer, skriv serveradressen ved første start og tilmeld dig med klassekoden.

Sæt så repo-variablen `HOLYMOLY_APP_URL` til adressen (*Settings → Secrets and variables → Actions → Variables*), så "Log ind" på GitHub-siden går til serveren.

## Databasen

Der skal ikke laves eller installeres en database. HolyMoly bruger SQLite, som er en fil (`holymoly.db`) i Docker-volumen `holymoly-data`. Den oprettes selv ved første start og opdateres selv, når HolyMoly bliver opdateret.

Data er beskyttet på to måder:

1. **HolyMoly** laver hver nat en hel kopi i `/data/backup/` (de seneste 7 gemmes).
2. **Proxmox' backup** af containeren tager det hele med: databasen, kopierne og skærmbillederne.

Hent nattens kopier ud af containeren:

```bash
cd /opt/holymoly && docker compose -f deploy/docker-compose.yml cp holymoly:/data/backup ./backup
```

Læg en kopi tilbage (stop først, så HolyMoly ikke skriver samtidig):

```bash
cd /opt/holymoly && docker compose -f deploy/docker-compose.yml stop holymoly
```

```bash
docker compose -f deploy/docker-compose.yml cp ./backup/holymoly-ÅÅÅÅ-MM-DD.db holymoly:/data/holymoly.db
```

```bash
docker compose -f deploy/docker-compose.yml start holymoly
```

## Drift

| Opgave | Sådan |
| --- | --- |
| Opdatering | `cd /opt/holymoly && git pull` og så samme `docker compose … up -d --build` som ved start |
| Backup | Proxmox: *Datacenter → Backup → Add*, dagligt, behold 7. Data ligger i Docker-volumen `holymoly-data` i containeren. |
| Log | `docker compose -f deploy/docker-compose.yml logs -f holymoly` |
| Glemt lærer-adgangskode | `docker compose -f deploy/docker-compose.yml exec holymoly node /app/scripts/enkel.js nulstil <brugernavn>` |
| Genstart efter strømsvigt | Sker af sig selv: containeren starter ved boot, Docker-tjenesterne har `restart: unless-stopped` |
