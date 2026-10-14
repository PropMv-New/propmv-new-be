#!/usr/bin/env bash
# =============================================================================
# PropMv - one-command production deploy (backend + notification-service + frontend + nginx)
#
# Usage (on your EC2 / VM, from the propmv/ directory):
#   bash deploy-production.sh
#
# Optional env overrides:
#   DEPLOY_BRANCH=development   Git branch to deploy (default: development)
#   SKIP_GIT_PULL=1             Skip git fetch/reset
#   SKIP_APT=1                  Skip apt package installs
#   WEB_ROOT=/var/www/myapp     Frontend static root (default: /var/www/myapp)
# =============================================================================
set -euo pipefail

# Script lives inside propmv/ - monorepo root is one level up
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${BACKEND_DIR}/.." && pwd)}"

# Auto-detect frontend dir - try common folder names
if [[ -z "${FRONTEND_DIR:-}" ]]; then
  for candidate in \
    "${REPO_ROOT}/PropMv-UI" \
    "${REPO_ROOT}/innago-inspired-refresh" \
    "${REPO_ROOT}/frontend"; do
    if [[ -f "${candidate}/package.json" ]]; then
      FRONTEND_DIR="$candidate"
      break
    fi
  done
fi

# Auto-detect notification service dir - try common folder names
if [[ -z "${NOTIF_DIR:-}" ]]; then
  for candidate in \
    "${REPO_ROOT}/propmv-notification-service" \
    "${REPO_ROOT}/notification-service"; do
    if [[ -f "${candidate}/package.json" ]]; then
      NOTIF_DIR="$candidate"
      break
    fi
  done
fi

FRONTEND_DIR="${FRONTEND_DIR:-}"
NOTIF_DIR="${NOTIF_DIR:-}"

[[ -n "$FRONTEND_DIR" ]] || die "Cannot find frontend directory. Pass FRONTEND_DIR=/path/to/frontend"
[[ -n "$NOTIF_DIR" ]]    || die "Cannot find notification-service directory. Pass NOTIF_DIR=/path/to/notif"
WEB_ROOT="${WEB_ROOT:-/var/www/myapp}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-development}"
NODE_MAJOR="${NODE_MAJOR:-22}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
die()  { echo -e "${RED}[deploy] ERROR:${NC} $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

read_env() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr -d '\r' | sed 's/^["'\''"]//;s/["'\''"]$//'
}

upsert_env() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  local tmp
  tmp="$(mktemp)"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    awk -v k="$key" -v v="$value" '
      BEGIN { done=0 }
      $0 ~ "^" k "=" { print k "=" v; done=1; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$file" > "$tmp"
  else
    cp "$file" "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" "$file"
}

derive_mongo_uri() {
  local uri="$1"
  echo "$uri" | sed -E 's^(mongodb(\+srv)?://[^/]+)/[^/?]+(\?.*)?^\1/\3^'
}

derive_mongo_db_name() {
  local db_url="$1"
  if [[ "$db_url" =~ mongodb(\+srv)?://[^/]+/([^/?]+) ]]; then
    echo "${BASH_REMATCH[2]}"
  else
    echo "PropMv"
  fi
}

install_prerequisites() {
  if [[ "${SKIP_APT:-0}" == "1" ]]; then
    log "SKIP_APT=1 - skipping system package installs"
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    log "Installing system packages (nginx, curl, git, redis optional)..."
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      curl git nginx ca-certificates gnupg redis-server 2>/dev/null || \
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl git nginx ca-certificates gnupg

    sudo systemctl enable nginx 2>/dev/null || true
    sudo systemctl start nginx 2>/dev/null || true
    sudo systemctl enable redis-server 2>/dev/null || true
    sudo systemctl start redis-server 2>/dev/null || warn "Redis not started (notifications still work without it)"
  else
    warn "Non-apt OS detected - ensure node, npm, pm2, nginx, and git are installed"
  fi

  local node_major=0
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -v | cut -d. -f1 | tr -d 'v')"
  fi

  if [[ "$node_major" -lt "$NODE_MAJOR" ]]; then
    log "Installing Node.js ${NODE_MAJOR}.x..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  log "Node $(node -v) | npm $(npm -v)"

  if ! command -v pm2 >/dev/null 2>&1; then
    log "Installing PM2 globally..."
    sudo npm install -g pm2
  fi
}

git_sync() {
  if [[ "${SKIP_GIT_PULL:-0}" == "1" ]]; then
    log "SKIP_GIT_PULL=1 - using current working tree"
    return
  fi
  log "Syncing git branch ${DEPLOY_BRANCH}..."
  cd "$REPO_ROOT"
  if [[ -d .git ]]; then
    git fetch origin "$DEPLOY_BRANCH"
    git checkout "$DEPLOY_BRANCH"
    git reset --hard "origin/${DEPLOY_BRANCH}"
  else
    warn "Not a git repo - deploying current files on disk"
  fi
}

ensure_backend_env() {
  local env_prod="${BACKEND_DIR}/.env.production"
  local env_local="${BACKEND_DIR}/.env.local"

  [[ -d "$BACKEND_DIR" ]] || die "Backend not found at ${BACKEND_DIR}"

  if [[ ! -f "$env_prod" ]] || [[ $(wc -l < "$env_prod" | tr -d ' ') -lt 10 ]]; then
    if [[ -f "$env_local" ]]; then
      cp "$env_local" "$env_prod"
      log "Seeded propmv/.env.production from .env.local"
    else
      die "Need propmv/.env.local or a complete propmv/.env.production"
    fi
  fi

  upsert_env "$env_prod" NODE_ENV production
  upsert_env "$env_prod" APP_PROFILE prod
  upsert_env "$env_prod" PORT 5000
  upsert_env "$env_prod" TRUST_PROXY 1
  upsert_env "$env_prod" NOTIFICATION_SERVICE_URL http://127.0.0.1:3000

  local api_key
  api_key="$(read_env "$env_prod" NOTIFICATION_SERVICE_API_KEY)"
  if [[ -z "$api_key" ]] || [[ "$api_key" == "propmv-internal-service-key" ]]; then
    api_key="$(openssl rand -hex 24)"
    upsert_env "$env_prod" NOTIFICATION_SERVICE_API_KEY "$api_key"
    log "Generated NOTIFICATION_SERVICE_API_KEY for backend"
  fi

  local jwt refresh
  jwt="$(read_env "$env_prod" JWT_SECRET)"
  if [[ -z "$jwt" ]] || [[ ${#jwt} -lt 16 ]] || [[ "$jwt" == "change_this_secret_in_production" ]]; then
    jwt="$(openssl rand -hex 32)"
    upsert_env "$env_prod" JWT_SECRET "$jwt"
    log "Generated JWT_SECRET for backend"
  fi

  refresh="$(read_env "$env_prod" REFRESH_TOKEN_SECRET)"
  if [[ -z "$refresh" ]] || [[ ${#refresh} -lt 16 ]]; then
    refresh="$(openssl rand -hex 32)"
    upsert_env "$env_prod" REFRESH_TOKEN_SECRET "$refresh"
    log "Generated REFRESH_TOKEN_SECRET for backend"
  fi

  if [[ -z "$(read_env "$env_prod" DB_URL)" ]]; then
    die "DB_URL missing in ${env_prod}"
  fi

  echo "$api_key"
}

ensure_notification_env() {
  local api_key="$1"
  local backend_env="${BACKEND_DIR}/.env.production"
  local env_prod="${NOTIF_DIR}/.env.production"
  local env_legacy="${NOTIF_DIR}/.env"

  [[ -d "$NOTIF_DIR" ]] || die "notification-service not found at ${NOTIF_DIR}"

  local jwt mongo_uri db_name
  jwt="$(read_env "$backend_env" JWT_SECRET)"
  mongo_uri="$(read_env "$env_prod" MONGO_URI)"
  [[ -z "$mongo_uri" ]] && mongo_uri="$(read_env "$env_legacy" MONGO_URI)"

  local db_url
  db_url="$(read_env "$backend_env" DB_URL)"
  if [[ -z "$mongo_uri" ]] && [[ -n "$db_url" ]]; then
    mongo_uri="$(derive_mongo_uri "$db_url")"
  fi
  [[ -n "$mongo_uri" ]] || die "Could not resolve MONGO_URI for notification-service"

  db_name="$(read_env "$env_prod" MONGO_DB_NAME)"
  [[ -z "$db_name" ]] && db_name="$(read_env "$env_legacy" MONGO_DB_NAME)"
  [[ -z "$db_name" ]] && db_name="$(derive_mongo_db_name "$db_url")"

  : > "$env_prod"
  upsert_env "$env_prod" PORT 3000
  upsert_env "$env_prod" NODE_ENV production
  upsert_env "$env_prod" WORKERS 1
  upsert_env "$env_prod" MONGO_URI "$mongo_uri"
  upsert_env "$env_prod" MONGO_DB_NAME "$db_name"
  upsert_env "$env_prod" RABBITMQ_URL amqp://127.0.0.1:5672
  upsert_env "$env_prod" RABBITMQ_QUEUE notifications
  upsert_env "$env_prod" RABBITMQ_PREFETCH 10
  upsert_env "$env_prod" REDIS_URL redis://127.0.0.1:6379
  upsert_env "$env_prod" JWT_SECRET "$jwt"
  upsert_env "$env_prod" SERVICE_API_KEY "$api_key"
  upsert_env "$env_prod" LOG_LEVEL info

  log "Wrote ${env_prod} (JWT + SERVICE_API_KEY synced with backend)"
}

deploy_backend() {
  log "Deploying propmv backend..."
  cd "$BACKEND_DIR"
  export NODE_ENV=production
  npm ci --omit=dev
  mkdir -p logs uploads

  if pm2 describe propmv-backend >/dev/null 2>&1; then
    pm2 reload ecosystem.config.js --update-env
  else
    pm2 start ecosystem.config.js --update-env
  fi
}

deploy_notification_service() {
  local deploy_script="${BACKEND_DIR}/scripts/deploy-notification-server.sh"
  [[ -f "$deploy_script" ]] || deploy_script="${BACKEND_DIR}/scripts/deploy-notification-service.sh"
  if [[ -f "$deploy_script" ]]; then
    SKIP_GIT_PULL=1 bash "$deploy_script"
    return
  fi

  log "Deploying notification-service (inline fallback)..."
  cd "$NOTIF_DIR"
  export NODE_ENV=production
  npm ci --omit=dev
  mkdir -p logs

  if pm2 describe notification-service >/dev/null 2>&1; then
    pm2 reload ecosystem.config.js --update-env
  else
    pm2 start ecosystem.config.js --update-env
  fi
}

deploy_frontend() {
  log "Building frontend..."
  cd "$FRONTEND_DIR"
  unset VITE_NOTIFICATION_SERVICE_URL 2>/dev/null || true
  npm ci --include=dev
  npm run build

  log "Publishing frontend to ${WEB_ROOT} (merge - retain previous hashed assets)..."
  sudo mkdir -p "$WEB_ROOT"
  sudo cp -r dist/* "$WEB_ROOT/"
  sudo chown -R www-data:www-data "$WEB_ROOT" 2>/dev/null || true
}

configure_nginx() {
  log "Installing nginx reverse proxy..."
  local backend_port notif_port
  backend_port="$(read_env "${BACKEND_DIR}/.env.production" PORT)"
  backend_port="${backend_port:-5000}"
  notif_port="$(read_env "${NOTIF_DIR}/.env.production" PORT)"
  notif_port="${notif_port:-3000}"

  chmod +x "${FRONTEND_DIR}/deploy/nginx/install-nginx.sh"
  BACKEND_PORT="$backend_port" NOTIFICATION_PORT="$notif_port" \
    bash "${FRONTEND_DIR}/deploy/nginx/install-nginx.sh"
}

health_checks() {
  local backend_port notif_port failed=0
  backend_port="$(read_env "${BACKEND_DIR}/.env.production" PORT)"
  backend_port="${backend_port:-5000}"
  notif_port="$(read_env "${NOTIF_DIR}/.env.production" PORT)"
  notif_port="${notif_port:-3000}"

  log "Running health checks..."

  if curl -fsS -L "http://127.0.0.1:${backend_port}/health" >/dev/null; then
    log " Backend healthy on :${backend_port}"
  else
    warn " Backend health check failed on :${backend_port}"
    failed=1
  fi

  if curl -fsS -L "http://127.0.0.1:${notif_port}/health" >/dev/null; then
    log " Notification service healthy on :${notif_port}"
  else
    warn " Notification service health check failed on :${notif_port}"
    failed=1
  fi

  if curl -fsS -L "http://127.0.0.1/" >/dev/null; then
    log " Frontend served by nginx"
  else
    warn " Frontend not reachable on port 80"
    failed=1
  fi

  # Probe Socket.IO directly on the backend port (bypasses nginx HTTP→HTTPS redirect)
  local notif_sse_status
  BODY="$(curl -fsS "http://127.0.0.1:${backend_port}/socket.io/?EIO=4&transport=polling" 2>/dev/null || true)"
  if echo "${BODY}" | grep -qE 'sid|\{"code"|0\{'; then
    log " Messaging Socket.IO OK (direct :${backend_port})"
  else
    warn " Messaging Socket.IO probe failed on :${backend_port} - check PM2 backend"
    failed=1
  fi

  # Probe notification SSE directly on the notification service port
  notif_sse_status="$(curl -o /dev/null -w "%{http_code}" -fsS --max-time 3 \
    "http://127.0.0.1:${notif_port}/api/notifications/stream?token=probe" 2>/dev/null || true)"
  if [[ "$notif_sse_status" == "401" ]] || [[ "$notif_sse_status" == "200" ]]; then
    log " Notification SSE OK (direct :${notif_port} - HTTP ${notif_sse_status})"
  else
    warn " Notification SSE probe failed (HTTP ${notif_sse_status}) - check PM2 notification-service"
    failed=1
  fi

  pm2 save
  pm2 startup systemd -u "${USER}" --hp "${HOME}" 2>/dev/null | tail -1 | bash 2>/dev/null || \
    warn "Run 'pm2 startup' once so services survive reboot"

  if [[ "$failed" -eq 0 ]]; then
    log "🚀 Deploy complete - open your site in the browser and test the bell icon."
  else
    warn "Deploy finished with warnings. Diagnostics:"
    pm2 status || true
    pm2 logs propmv-backend --lines 30 --nostream 2>/dev/null || true
    pm2 logs notification-service --lines 30 --nostream 2>/dev/null || true
    exit 1
  fi
}

main() {
  log "PropMv production deploy - repo: ${REPO_ROOT}"
  log "  backend  : ${BACKEND_DIR}"
  log "  frontend : ${FRONTEND_DIR}"
  log "  notif    : ${NOTIF_DIR}"
  [[ -d "$BACKEND_DIR" ]] || die "Backend not found at ${BACKEND_DIR}"
  [[ -d "$FRONTEND_DIR" ]] || die "Frontend not found at ${FRONTEND_DIR}"
  [[ -d "$NOTIF_DIR" ]]   || die "Notification service not found at ${NOTIF_DIR}"

  install_prerequisites
  git_sync

  local api_key
  api_key="$(ensure_backend_env)"
  ensure_notification_env "$api_key"

  deploy_backend
  deploy_notification_service
  deploy_frontend
  configure_nginx
  health_checks
}

main "$@"
