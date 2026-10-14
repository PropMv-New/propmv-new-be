#!/usr/bin/env bash
# =============================================================================
# PropMv - deploy / repair the notification microservice (PM2)
#
# Syncs JWT + service API key from the backend, installs deps, (re)starts PM2,
# and runs health checks. Handles legacy paths and PM2 app names from older
# deployments (e.g. propmv-notification-service).
#
# Usage (on EC2 or any Linux host):
#   bash propmv/scripts/deploy-notification-service.sh
#
# From inside propmv/:
#   bash scripts/deploy-notification-service.sh
#
# Optional env overrides:
#   NOTIF_DIR=/path/to/notification-service   Force notification service path
#   BACKEND_DIR=/path/to/propmv               Force backend path
#   DEPLOY_BRANCH=development                 Git branch to pull (monorepo)
#   SKIP_GIT_PULL=1                           Skip git fetch/reset
#   SKIP_APT=1                                Skip apt package installs
#   WITH_RABBITMQ=1                           Install/start RabbitMQ if missing
#   RELOAD_BACKEND=1                          pm2 reload propmv-backend after deploy
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

# When deployed as standalone backend repo (~/propmv), REPO_ROOT = BACKEND_DIR.
# When inside monorepo (propmv/ subfolder), REPO_ROOT = parent directory.
if [[ -d "${BACKEND_DIR}/.git" ]] && [[ ! -d "${BACKEND_DIR}/../notification-service" ]] && [[ ! -d "${BACKEND_DIR}/../propmv-notification-service" ]]; then
  REPO_ROOT="${BACKEND_DIR}"
else
  REPO_ROOT="${REPO_ROOT:-$(cd "${BACKEND_DIR}/.." && pwd)}"
fi

DEPLOY_BRANCH="${DEPLOY_BRANCH:-development}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[notif-deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[notif-deploy]${NC} $*"; }
die()  { echo -e "${RED}[notif-deploy] ERROR:${NC} $*" >&2; exit 1; }

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

detect_notif_dir() {
  if [[ -n "${NOTIF_DIR:-}" ]] && [[ -f "${NOTIF_DIR}/package.json" ]]; then
    echo "$NOTIF_DIR"
    return
  fi

  local candidate
  for candidate in \
    "${HOME}/propmv-notification-service" \
    "/home/ubuntu/propmv-notification-service" \
    "${BACKEND_DIR%/}/../notification-service" \
    "${BACKEND_DIR%/}/../propmv-notification-service" \
    "${REPO_ROOT}/notification-service" \
    "${REPO_ROOT}/propmv-notification-service" \
    "${HOME}/propmv/notification-service" \
    "${HOME}/notification-service" \
    "/home/ubuntu/propmv/notification-service" \
    "/var/www/notification-service"; do
    if [[ -f "${candidate}/package.json" ]] && [[ -f "${candidate}/src/server.js" ]]; then
      echo "$candidate"
      return
    fi
  done

  die "Could not find notification-service. Set NOTIF_DIR=/path/to/notification-service"
}

install_prerequisites() {
  if [[ "${SKIP_APT:-0}" == "1" ]]; then
    log "SKIP_APT=1 - skipping system package installs"
    return
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    warn "Non-apt OS - ensure node, npm, pm2, and redis are installed"
    return
  fi

  log "Ensuring Redis is available..."
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redis-server curl 2>/dev/null || true
  sudo systemctl enable redis-server 2>/dev/null || true
  sudo systemctl start redis-server 2>/dev/null || warn "Redis not started (rate limiting disabled without it)"

  if [[ "${WITH_RABBITMQ:-0}" == "1" ]]; then
    if ! systemctl is-active --quiet rabbitmq-server 2>/dev/null; then
      log "Installing RabbitMQ..."
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rabbitmq-server
      sudo systemctl enable rabbitmq-server
      sudo systemctl start rabbitmq-server
      sudo rabbitmq-plugins enable rabbitmq_management 2>/dev/null || true
      log "RabbitMQ started (management UI: http://127.0.0.1:15672 guest/guest)"
    else
      log "RabbitMQ already running"
    fi
  fi

  if ! command -v pm2 >/dev/null 2>&1; then
    log "Installing PM2..."
    sudo npm install -g pm2
  fi
}

git_sync() {
  if [[ "${SKIP_GIT_PULL:-0}" == "1" ]]; then
    log "SKIP_GIT_PULL=1 - using current working tree"
    return
  fi

  # Standalone backend repo (typical EC2 layout: ~/propmv)
  if [[ -d "${BACKEND_DIR}/.git" ]]; then
    log "Syncing backend repo at ${BACKEND_DIR}..."
    cd "$BACKEND_DIR"
    local branch
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$DEPLOY_BRANCH")"
    git fetch origin "$branch" 2>/dev/null || git fetch origin "$DEPLOY_BRANCH" 2>/dev/null || true
    git pull --ff-only origin "$branch" 2>/dev/null || \
      git pull --ff-only origin "$DEPLOY_BRANCH" 2>/dev/null || \
      warn "Backend git pull skipped (already up to date or no remote branch)"
  elif [[ -d "${REPO_ROOT}/.git" ]]; then
    log "Syncing monorepo branch ${DEPLOY_BRANCH}..."
    cd "$REPO_ROOT"
    git fetch origin "$DEPLOY_BRANCH"
    git checkout "$DEPLOY_BRANCH"
    git reset --hard "origin/${DEPLOY_BRANCH}"
  fi

  if [[ -d "${NOTIF_DIR}/.git" ]] && [[ "${NOTIF_DIR}" != "${BACKEND_DIR}" ]]; then
    log "Syncing notification-service at ${NOTIF_DIR}..."
    cd "$NOTIF_DIR"
    local notif_branch
    notif_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$DEPLOY_BRANCH")"
    git fetch origin "$notif_branch" 2>/dev/null || git fetch origin "$DEPLOY_BRANCH" 2>/dev/null || true
    git pull --ff-only origin "$notif_branch" 2>/dev/null || \
      git pull --ff-only origin "$DEPLOY_BRANCH" 2>/dev/null || \
      warn "Notification-service git pull skipped"
  elif [[ ! -d "${BACKEND_DIR}/.git" ]] && [[ ! -d "${REPO_ROOT}/.git" ]]; then
    warn "No git repo found - deploying files on disk"
  fi
}

ensure_backend_notification_env() {
  local env_prod="${BACKEND_DIR}/.env.production"
  local env_local="${BACKEND_DIR}/.env.local"

  [[ -f "$env_prod" ]] || [[ -f "$env_local" ]] || die "Need propmv/.env.production or .env.local"

  if [[ ! -f "$env_prod" ]] && [[ -f "$env_local" ]]; then
    cp "$env_local" "$env_prod"
    log "Seeded propmv/.env.production from .env.local"
  fi

  upsert_env "$env_prod" NOTIFICATION_SERVICE_URL http://127.0.0.1:3000

  local api_key jwt
  api_key="$(read_env "$env_prod" NOTIFICATION_SERVICE_API_KEY)"
  if [[ -z "$api_key" ]] || [[ "$api_key" == "propmv-internal-service-key" ]]; then
    api_key="$(openssl rand -hex 24)"
    upsert_env "$env_prod" NOTIFICATION_SERVICE_API_KEY "$api_key"
    log "Generated NOTIFICATION_SERVICE_API_KEY for backend"
  fi

  jwt="$(read_env "$env_prod" JWT_SECRET)"
  if [[ -z "$jwt" ]] || [[ ${#jwt} -lt 16 ]] || [[ "$jwt" == "change_this_secret_in_production" ]]; then
    jwt="$(openssl rand -hex 32)"
    upsert_env "$env_prod" JWT_SECRET "$jwt"
    log "Generated JWT_SECRET for backend"
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

  local jwt mongo_uri db_name db_url
  jwt="$(read_env "$backend_env" JWT_SECRET)"
  mongo_uri="$(read_env "$env_prod" MONGO_URI)"
  [[ -z "$mongo_uri" ]] && mongo_uri="$(read_env "$env_legacy" MONGO_URI)"

  db_url="$(read_env "$backend_env" DB_URL)"
  if [[ -z "$mongo_uri" ]] && [[ -n "$db_url" ]]; then
    mongo_uri="$(derive_mongo_uri "$db_url")"
  fi
  [[ -n "$mongo_uri" ]] || die "Could not resolve MONGO_URI (set DB_URL in backend env or MONGO_URI in notification env)"

  db_name="$(read_env "$env_prod" MONGO_DB_NAME)"
  [[ -z "$db_name" ]] && db_name="$(read_env "$env_legacy" MONGO_DB_NAME)"
  [[ -z "$db_name" ]] && db_name="$(derive_mongo_db_name "$db_url")"

  # Push (FCM) credentials. The file is rewritten from scratch below, which
  # used to erase a FIREBASE_SERVICE_ACCOUNT added by hand on every deploy, so
  # push stayed disabled. Keep it, or take it from the backend env. Use the
  # base64 of the service-account JSON so it stays on one line.
  local firebase gac
  firebase="$(read_env "$env_prod" FIREBASE_SERVICE_ACCOUNT)"
  [[ -z "$firebase" ]] && firebase="$(read_env "$env_legacy" FIREBASE_SERVICE_ACCOUNT)"
  [[ -z "$firebase" ]] && firebase="$(read_env "$backend_env" FIREBASE_SERVICE_ACCOUNT)"
  gac="$(read_env "$env_prod" GOOGLE_APPLICATION_CREDENTIALS)"
  [[ -z "$gac" ]] && gac="$(read_env "$env_legacy" GOOGLE_APPLICATION_CREDENTIALS)"

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
  if [[ -n "$firebase" ]]; then
    upsert_env "$env_prod" FIREBASE_SERVICE_ACCOUNT "$firebase"
  elif [[ -n "$gac" ]]; then
    upsert_env "$env_prod" GOOGLE_APPLICATION_CREDENTIALS "$gac"
  else
    warn "No FIREBASE_SERVICE_ACCOUNT - push notifications to phones stay disabled"
  fi

  log "Wrote ${env_prod} (JWT + SERVICE_API_KEY synced with backend)"
}

cleanup_legacy_pm2() {
  local legacy
  for legacy in propmv-notification-service "notification service" notifica; do
    if pm2 describe "$legacy" >/dev/null 2>&1; then
      warn "Removing legacy PM2 app: ${legacy}"
      pm2 delete "$legacy" 2>/dev/null || true
    fi
  done
}

deploy_pm2() {
  log "Installing npm dependencies..."
  cd "$NOTIF_DIR"
  export NODE_ENV=production
  npm ci --omit=dev
  mkdir -p logs

  cleanup_legacy_pm2

  if pm2 describe notification-service >/dev/null 2>&1; then
    log "Reloading notification-service via PM2..."
    pm2 reload ecosystem.config.js --update-env
  else
    log "Starting notification-service via PM2..."
    pm2 start ecosystem.config.js --update-env
  fi

  pm2 save 2>/dev/null || true
}

reload_backend_if_requested() {
  if [[ "${RELOAD_BACKEND:-0}" != "1" ]]; then
    return
  fi
  if pm2 describe propmv-backend >/dev/null 2>&1; then
    log "Reloading propmv-backend to pick up env changes..."
    cd "$BACKEND_DIR"
    pm2 reload ecosystem.config.js --update-env 2>/dev/null || pm2 restart propmv-backend --update-env
  fi
}

health_checks() {
  local port api_key failed=0
  port="$(read_env "${NOTIF_DIR}/.env.production" PORT)"
  port="${port:-3000}"
  api_key="$(read_env "${NOTIF_DIR}/.env.production" SERVICE_API_KEY)"

  log "Running health checks on port ${port}..."

  local ok=0 i
  for i in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
  done

  if [[ "$ok" -eq 1 ]]; then
    log " Health check passed (http://127.0.0.1:${port}/health)"
  else
    warn " Health check failed on port ${port}"
    failed=1
  fi

  local sse_status
  sse_status="$(curl -o /dev/null -w "%{http_code}" --max-time 3 \
    "http://127.0.0.1:${port}/api/notifications/stream?token=probe" 2>/dev/null || true)"
  if [[ "$sse_status" == "401" ]] || [[ "$sse_status" == "200" ]]; then
    log " SSE endpoint reachable (HTTP ${sse_status})"
  else
    warn " SSE endpoint probe failed (HTTP ${sse_status})"
    failed=1
  fi

  if [[ -n "$api_key" ]]; then
    local create_status
    create_status="$(curl -o /dev/null -w "%{http_code}" --max-time 5 \
      -X POST "http://127.0.0.1:${port}/api/notifications" \
      -H "Content-Type: application/json" \
      -H "x-service-key: ${api_key}" \
      -d '{"userId":"deploy-probe","title":"Deploy probe","message":"Health check","type":"system"}' \
      2>/dev/null || true)"
    if [[ "$create_status" == "202" ]] || [[ "$create_status" == "201" ]]; then
      log " Service API key accepted (POST /api/notifications → HTTP ${create_status})"
    else
      warn " Service API key probe failed (HTTP ${create_status}) - check SERVICE_API_KEY sync"
      failed=1
    fi
  fi

  if [[ "$failed" -eq 0 ]]; then
    log "🚀 Notification service deploy complete"
    pm2 status notification-service 2>/dev/null || pm2 status
  else
    warn "Deploy finished with errors. Recent logs:"
    pm2 logs notification-service --lines 40 --nostream 2>/dev/null || true
    exit 1
  fi
}

main() {
  NOTIF_DIR="$(detect_notif_dir)"
  log "Backend : ${BACKEND_DIR}"
  log "Notif   : ${NOTIF_DIR}"
  log "Repo    : ${REPO_ROOT}"

  install_prerequisites
  git_sync

  local api_key
  api_key="$(ensure_backend_notification_env)"
  ensure_notification_env "$api_key"

  deploy_pm2
  reload_backend_if_requested
  health_checks
}

main "$@"
