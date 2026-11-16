#!/usr/bin/env bash
# =====================================================================
# Welfare Pride HPP Reporting Portal — Automated Deployment Script
# Supports: Ubuntu/Debian VPS (systemd + Caddy HTTPS), Docker, Hostinger-verify
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
for arg in "$@"; do
  case "$arg" in
    --method=*)     METHOD="${arg#*=}" ;;
    --domain=*)     DOMAIN="${arg#*=}" ;;
    --email=*)      ADMIN_EMAIL="${arg#*=}" ;;
    --no-caddy)     WITH_CADDY="no" ;;
    --skip-admin)   SKIP_ADMIN="yes" ;;
    -h|--help)
      cat <<USAGE
Usage: $0 [--method=vps|docker|hostinger-check] [--domain=example.org] [--email=admin@example.org] [--no-caddy]
Installs the Welfare Pride HPP Reporting Portal on Ubuntu/Debian VPS, bare metal, or Docker.
USAGE
      exit 0 ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

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
  read -r -p "Select [1/2/3]: " choice
  case "$choice" in
    1) METHOD="vps" ;;
    2) METHOD="docker" ;;
    3) METHOD="hostinger-check" ;;
    *) die "Invalid selection." ;;
  esac
fi

prompt_config() {
  if [[ -z "$DOMAIN" ]]; then
    read -r -p "Portal domain or IP (e.g. beacon.welfarepride.org or 203.0.113.5) [127.0.0.1]: " DOMAIN
    DOMAIN="${DOMAIN:-127.0.0.1}"
  fi
  if [[ -z "$ADMIN_EMAIL" ]]; then
    local def="admin@${DOMAIN}"
    read -r -p "Initial administrator email [$def]: " ADMIN_EMAIL
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
ENV
  chown "${APP_USER}:${APP_USER}" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"

  log "7/8 Installing systemd service…"
  sed "s#/opt/welfare-pride-portal#${APP_DIR}#g; s#portal#${APP_USER}#g" deploy/systemd/welfare-pride-portal.service > /etc/systemd/system/welfare-pride-portal.service
  systemctl daemon-reload
  systemctl enable --now welfare-pride-portal.service >/dev/null
  sleep 3

  # health check
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || {
    journalctl -u welfare-pride-portal.service --no-pager -n 40
    die "Service failed to start. See journal output above."
  }
  ok "Application service running at http://127.0.0.1:${PORT}"

  # optional Caddy HTTPS
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

  # 8/8 create administrator automatically
  if [[ "$SKIP_ADMIN" != "yes" ]]; then
    log "8/8 Creating initial administrator account…"
    su -s /bin/bash "$APP_USER" -c "
      set -a; source '$APP_DIR/.env'; set +a;
      node --import tsx - << 'NODE'
const { bootstrapFirstAdmin, db } = await import('./server/repository.js');
const { hashPassword } = await import('./server/security.js');
const email = process.env.BOOT_EMAIL;
const pwd   = process.env.BOOT_PWD;
try {
  const hash = await hashPassword(pwd);
  bootstrapFirstAdmin(email, hash);
  process.exit(0);
} catch (e) {
  process.stderr.write(String(e.message||e));
  process.exit(1);
} finally { try { db.close(); } catch {} }
NODE" <<BOOTENV
export BOOT_EMAIL='$ADMIN_EMAIL'
BOOT_PWD='$A_PWD'
BOOTENV
    # fallback: non-fatal if already created
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
    docker compose exec -T app node --import tsx server/bootstrap-admin.ts --email "$ADMIN_EMAIL" >/dev/null 2>&1 || true
  fi

  print_summary
}

# ==================== METHOD: HOSTINGER CHECK ====================
install_hostinger_check() {
  echo ""
  echo -e "${BOLD}Hostinger deployment verification:${RESET}"
  read -r -p "Enter your deployed URL (e.g. https://beacon.welfarepride.org): " HURL
  echo ""
  echo -n "Health check: "
  curl -fsS --max-time 15 "${HURL}/healthz" 2>/dev/null && ok "healthy" || warn "health endpoint did not respond"
  echo -n "Setup status: "
  curl -s --max-time 15 "${HURL}/api/v1/auth/setup/status" 2>/dev/null || echo "(unavailable)"
  echo ""
  echo -n "Live JS asset: "
  curl -s --max-time 15 "${HURL}/" 2>/dev/null | grep -o 'src="/assets/index-[^"]*"' || echo "(unavailable)"
  echo ""
  echo "Expected current build asset: index-CWgnbSkc.js"
  echo "If the live asset differs, click Redeploy in Hostinger."
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
  echo "  3. Enroll multi-factor authentication (scan the QR code) and SAVE the recovery codes"
  echo "  4. You will be prompted to change the temporary password on first sign-in"
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
  vps)             install_vps ;;
  docker)          install_docker ;;
  hostinger-check) install_hostinger_check ;;
  *) die "Unknown method: $METHOD" ;;
esac
