#!/usr/bin/env bash
# =====================================================================
# Welfare Pride HPP Reporting Portal — Automated Deployment Script
# Supports: Ubuntu/Debian VPS / bare metal (systemd + Caddy HTTPS),
# Docker containers, and a Hostinger verification check.
# =====================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MadaSito/welfare-pride-hpp-reporting-portal.git}"
APP_DIR="${APP_DIR:-/opt/welfare-pride-portal}"
DATA_DIR="${DATA_DIR:-/var/lib/welfare-pride-portal/data}"
APP_USER="${APP_USER:-portal}"
PORT="${PORT:-3000}"
NODE_VERSION="22"

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"
log()    { echo -e "${CYAN}▶${RESET} $*"; }
ok()     { echo -e "${GREEN}✔${RESET} $*"; }
warn()   { echo -e "${YELLOW}▲${RESET} $*"; }
die()    { echo -e "${RED}✖${RESET} $*" >&2; exit 1; }

# ---------- argument parsing ----------
METHOD=""
DOMAIN=""
ADMIN_EMAIL=""
WITH_CADDY="yes"
SKIP_ADMIN=""
HURL=""

for arg in "$@"; do
  case "$arg" in
    --method=*)     METHOD="${arg#*=}" ;;
    --domain=*)     DOMAIN="${arg#*=}" ;;
    --email=*)      ADMIN_EMAIL="${arg#*=}" ;;
    --url=*)        HURL="${arg#*=}" ;;
    --no-caddy)     WITH_CADDY="no" ;;
    --skip-admin)   SKIP_ADMIN="yes" ;;
    -h|--help)
      cat <<USAGE
Usage: $0 [--method=vps|docker|hostinger-check] [--domain=example.org] [--email=admin@example.org] [--no-caddy]
Installs the Welfare Pride HPP Reporting Portal on Ubuntu/Debian VPS, bare metal, or Docker.
Options:
  --method=vps|baremetal|docker|hostinger-check   Deployment method (prompts if omitted)
  --domain=DOMAIN          Portal domain or server IP
  --email=EMAIL            Initial administrator email
  --no-caddy               Skip automatic Caddy HTTPS
  --skip-admin             Do not auto-create an admin account
USAGE
      exit 0 ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

read_input() {
  local prompt=$1 var=$2
  if [[ -t 0 ]]; then read -r -p "$prompt" "$var"
  elif [[ -r /dev/tty ]]; then read -r -p "$prompt" "$var" < /dev/tty
  else printf -v "$var" ""; fi
}

find_node() {
  for c in /usr/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)" $(which -a node 2>/dev/null) /root/.nvm/versions/node/*/bin/node /home/*/.nvm/versions/node/*/bin/node; do
    if [[ -n "$c" && -x "$c" ]]; then echo "$c"; return 0; fi
  done
  return 1
}

require_root() { [[ $EUID -eq 0 ]] || die "Run this installer as root (e.g. sudo $0)."; }

# ---------- method selection ----------
if [[ -z "$METHOD" ]]; then
  echo ""
  echo -e "${BOLD}Welfare Pride HPP Reporting Portal — Installation Wizard${RESET}"
  echo "Choose your deployment method:"
  echo ""
  echo "  1) VPS / bare metal (Ubuntu 22.04+/Debian 12+ — systemd service, optional Caddy HTTPS)"
  echo "  2) Docker container (docker compose, persistent SQLite volume)"
  echo "  3) Hostinger verification check (validate an existing Hostinger deployment)"
  echo ""
  while true; do
    read_input "Select [1/2/3]: " choice
    case "$choice" in
      1) METHOD="vps"; break ;;
      2) METHOD="docker"; break ;;
      3) METHOD="hostinger-check"; break ;;
      *) [[ -n "$choice" ]] && warn "Invalid selection '$choice' — please enter 1, 2, or 3." || die "No terminal input available. Pass --method=vps|docker|hostinger-check explicitly." ;;
    esac
  done
fi

prompt_config() {
  if [[ -z "$DOMAIN" ]]; then
    read_input "Portal domain or IP (e.g. beacon.welfarepride.org or 203.0.113.5) [127.0.0.1]: " DOMAIN
    DOMAIN="${DOMAIN:-127.0.0.1}"
  fi
  if [[ -z "$ADMIN_EMAIL" ]]; then
    local def="admin@${DOMAIN}"
    read_input "Initial administrator email [$def]: " ADMIN_EMAIL
    ADMIN_EMAIL="${ADMIN_EMAIL:-$def}"
  fi
}

gen_secrets() {
  S_SECRET=$(node -e "const c=require('node:crypto');process.stdout.write(c.randomBytes(36).toString('base64url'));")
  E_KEY=$(node -e "const c=require('node:crypto');process.stdout.write(c.randomBytes(32).toString('base64'));")
  A_PWD="A1!b2@#"$(node -e "const c=require('node:crypto');process.stdout.write(c.randomBytes(24).toString('base64url'));")
}

origin_url() {
  if [[ "$WITH_CADDY" == "yes" && "$DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    echo "https://${DOMAIN}"
  else
    echo "http://${DOMAIN}:${PORT}"
  fi
}

# ==================== METHOD: VPS / BARE METAL ====================
install_vps() {
  require_root
  prompt_config

  log "1/8 Installing OS dependencies…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl git build-essential ca-certificates >/dev/null

  log "2/8 Installing Node.js ${NODE_VERSION} LTS and pnpm…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - >/dev/null 2>&1 || true
  apt-get install -y -qq nodejs >/dev/null
  node -v >/dev/null 2>&1 || die "Node.js installation failed."
  npm install -g -q pnpm@10.4.1 >/dev/null

  log "3/8 Cloning repository into ${APP_DIR}…"
  if [[ -d "$APP_DIR/.git" ]]; then
    cd "$APP_DIR" && git fetch -q origin && git checkout -q main && git pull -q origin main
  else
    mkdir -p "$APP_DIR"
    git clone -q "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
  fi

  TOTAL_RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  if [[ "$TOTAL_RAM_MB" -lt 900 ]] && ! grep -q 'swap' /proc/swaps 2>/dev/null; then
    log "Low RAM detected (${TOTAL_RAM_MB} MB) — enabling 1 GB swap so the build succeeds…"
    fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 2>/dev/null
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile 2>/dev/null || true
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "1 GB swap enabled"
  fi

  log "4/8 Installing dependencies and building the portal…"
  pnpm install --frozen-lockfile >/dev/null
  pnpm run build >/dev/null
  [[ -f dist/index.js ]] || die "Build failed — dist/index.js missing."

  log "5/8 Creating application user and persistent data directory…"
  id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home "$APP_DIR" "$APP_USER"
  mkdir -p "$DATA_DIR"
  chown -R "${APP_USER}:${APP_USER}" "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"

  log "6/8 Generating secrets and .env configuration…"
  gen_secrets
  APP_ORIGIN="$(origin_url)"
  cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
PORT=${PORT}
APP_ORIGIN=${APP_ORIGIN}
APP_SESSION_SECRET=${S_SECRET}
APP_ENCRYPTION_KEY=${E_KEY}
DATA_DIR=${DATA_DIR}
TRUST_PROXY=1
VITE_APP_ID=readypackets
ENV
  chown "${APP_USER}:${APP_USER}" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"

  log "7/8 Installing systemd service…"
  sed "s#/opt/welfare-pride-portal#${APP_DIR}#g; s#portal#${APP_USER}#g" deploy/systemd/welfare-pride-portal.service > /etc/systemd/system/welfare-pride-portal.service
  systemctl daemon-reload
  systemctl enable --now welfare-pride-portal.service >/dev/null
  sleep 3

  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || {
    journalctl -u welfare-pride-portal.service --no-pager -n 40
    die "Service failed to start. See journal output above."
  }
  ok "Application service running at http://127.0.0.1:${PORT}"

  if [[ "$WITH_CADDY" == "yes" && "$DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    log "Configuring Caddy for automatic HTTPS (${DOMAIN})…"
    if ! command -v caddy >/dev/null 2>&1; then
      apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      apt-get update -qq && apt-get install -y -qq caddy >/dev/null
    fi
    sed "s/beacon.welfarepride.org/${DOMAIN}/g; s/127.0.0.1:3000/127.0.0.1:${PORT}/g" deploy/Caddyfile > /etc/caddy/Caddyfile
    systemctl enable --now caddy >/dev/null 2>&1
    systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
    ok "Caddy installed and configured for https://${DOMAIN}"
  fi

  if [[ "$SKIP_ADMIN" != "yes" ]]; then
    log "8/8 Creating initial administrator account…"
    BOOT_JS="$APP_DIR/.bootstrap-admin.mjs"
    cat > "$BOOT_JS" << 'BOOTJS'
import { bootstrapFirstAdmin, db } from "./server/repository.js";
import { hashPassword } from "./server/security.js";
const email = process.env.BOOT_EMAIL;
const pwd   = process.env.BOOT_PWD;
if (!email || !pwd) { process.stderr.write("missing BOOT_EMAIL/BOOT_PWD\n"); process.exit(1); }
try {
  const hash = await hashPassword(pwd);
  bootstrapFirstAdmin(email, hash);
  process.stdout.write("OK\n");
  process.exit(0);
} catch (e) {
  process.stderr.write(String(e.message || e) + "\n");
  process.exit(1);
} finally {
  try { db.close(); } catch {}
}
BOOTJS
    chown "${APP_USER}:${APP_USER}" "$BOOT_JS"
    chmod 600 "$BOOT_JS"
    NODE_BIN="$(find_node || true)"
    BOOT_OUT=""
    if [[ -n "$NODE_BIN" ]]; then
      BOOT_OUT=$(su -m -s /bin/bash "$APP_USER" -c "
        set -a; source '${APP_DIR}/.env' 2>/dev/null; set +a
        export BOOT_EMAIL='$ADMIN_EMAIL' BOOT_PWD='$A_PWD'
        cd '${APP_DIR}'
        '${NODE_BIN}' --import tsx .bootstrap-admin.mjs 2>&1") || true
    fi
    rm -f "$BOOT_JS"
    [[ "$BOOT_OUT" == *"OK"* ]] || warn "Admin creation note: ${BOOT_OUT}"
    python3 -c "import sqlite3; c=sqlite3.connect('${DATA_DIR}/portal.db').cursor(); r=c.execute('SELECT email, role FROM users WHERE lower(email)=lower(?)', ('${ADMIN_EMAIL}',)).fetchone(); import sys; sys.exit(0 if r and r[1]=='super_admin' else 1)" && ok "Administrator account verified: ${ADMIN_EMAIL} (super_admin)" || warn "Admin verification check could not confirm the account — check the note above."
  fi
  print_summary
}

# ==================== METHOD: DOCKER ====================
install_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is required but not installed. Install Docker first: https://docs.docker.com/engine/install/"
  command -v docker-compose >/dev/null 2>&1 || docker compose version >/dev/null 2>&1 || die "docker compose is required."
  prompt_config

  log "1/5 Cloning repository…"
  mkdir -p "$APP_DIR" && git clone -q "$REPO_URL" "$APP_DIR" 2>/dev/null || (cd "$APP_DIR" && git pull -q origin main)
  cd "$APP_DIR"

  log "2/5 Generating secrets and .env…"
  gen_secrets
  APP_ORIGIN="$(origin_url)"
  cat > .env <<ENV
NODE_ENV=production
APP_ORIGIN=${APP_ORIGIN}
APP_SESSION_SECRET=${S_SECRET}
APP_ENCRYPTION_KEY=${E_KEY}
VITE_APP_ID=readypackets
ENV
  chmod 600 .env

  log "3/5 Building and starting containers…"
  docker compose build
  docker compose up -d

  log "4/5 Waiting for application to report healthy…"
  for i in $(seq 1 30); do
    if docker compose exec -T app curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker compose exec -T app curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1 || die "App container did not become healthy."

  if [[ "$SKIP_ADMIN" != "yes" ]]; then
    log "5/5 Creating initial administrator…"
    docker compose exec -T -e BOOT_EMAIL="$ADMIN_EMAIL" -e BOOT_PWD="$A_PWD" app node --import tsx - << 'BOOTJS' 2>/dev/null || true
(async () => {
  const { bootstrapFirstAdmin, db } = await import("./server/repository.js");
  const { hashPassword } = await import("./server/security.js");
  const email = process.env.BOOT_EMAIL; const pwd = process.env.BOOT_PWD;
  if (!email || !pwd) { process.exit(1); }
  const hash = await hashPassword(pwd);
  bootstrapFirstAdmin(email, hash);
  db.close();
})();
BOOTJS
  fi
  print_summary
}

# ==================== METHOD: HOSTINGER CHECK ====================
install_hostinger_check() {
  echo ""
  echo -e "${BOLD}Hostinger deployment verification:${RESET}"
  if [[ -z "$HURL" ]]; then
    read_input "Enter your deployed URL (e.g. https://beacon.welfarepride.org): " HURL
  fi
  HURL="${HURL%/}"
  echo ""
  echo -n "Health check: "
  curl -fsS --max-time 15 "${HURL}/healthz" 2>/dev/null && ok "healthy" || warn "health endpoint did not respond"
  echo ""
  echo -n "Setup status: "
  curl -s --max-time 15 "${HURL}/api/v1/auth/setup/status" 2>/dev/null || echo "(unavailable)"
  echo ""
  echo ""
  echo -n "Live JS asset: "
  curl -s --max-time 15 "${HURL}/" 2>/dev/null | grep -o 'src="/assets/index-[^"]*"' || echo "(unavailable)"
  echo ""
  echo "If anything looks wrong, redeploy from Hostinger hPanel → Node.js app."
  exit 0
}

# ==================== SUMMARY ====================
print_summary() {
  echo ""
  echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════${RESET}"
  echo -e "${GREEN}${BOLD} ✔  Welfare Pride HPP Reporting Portal — Installation complete${RESET}"
  echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════${RESET}"
  echo ""
  echo -e "  Portal URL:             ${BOLD}${APP_ORIGIN}${RESET}"
  echo -e "  Administrator username: ${BOLD}${ADMIN_EMAIL}${RESET}"
  echo -e "  Administrator password: ${BOLD}${A_PWD}${RESET}"
  echo ""
  echo -e "${YELLOW}Important — save these credentials now. The password is not displayed again.${RESET}"
  echo ""
  echo -e "${BOLD}How to access the application:${RESET}"
  echo "  1. Open ${APP_ORIGIN} in your browser"
  echo "  2. Sign in with the username and password above"
  echo "  3. Change the temporary password to one of your choosing at first sign-in"
  echo "  4. (Optional) MFA is off by default — require it anytime per user in Settings \u2192 People & access"
  echo "  5. From the dashboard, configure Email Engine, branding, and add additional users"
  echo ""
  echo -e "${BOLD}Maintenance commands:${RESET}"
  echo "  systemctl status welfare-pride-portal   # check service"
  echo "  journalctl -u welfare-pride-portal -f  # live logs"
  echo "  systemctl restart welfare-pride-portal  # restart"
  echo "  Backup: copy ${DATA_DIR}/portal.db while the service is stopped, or use SQLite VACUUM INTO"
  echo ""
}

case "$METHOD" in
  vps|baremetal)   install_vps ;;
  docker)          install_docker ;;
  hostinger-check) install_hostinger_check ;;
  *) die "Unknown method: $METHOD" ;;
esac
