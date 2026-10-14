#!/usr/bin/env bash
# =============================================================================
# PropMv - complete local notification service setup
#
# Run from the backend repo (propmv/):
#   bash scripts/setup-notification-local.sh
#   bash scripts/setup-notification-local.sh --start
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[notif-setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[notif-setup]${NC} $*"; }
die()  { echo -e "${RED}[notif-setup] ERROR:${NC} $*" >&2; exit 1; }

detect_notif_dir() {
  local candidate
  for candidate in \
    "${BACKEND_DIR}/../notification-service" \
    "${BACKEND_DIR}/../propmv-notification-service" \
    "${BACKEND_DIR}/notification-service"; do
    if [[ -f "${candidate}/package.json" ]]; then
      echo "$candidate"
      return
    fi
  done
  return 1
}

NOTIF_DIR="$(detect_notif_dir)" || die "notification-service not found next to propmv (expected ../notification-service)"

START_RABBIT=1
START_SERVICE=0

for arg in "$@"; do
  case "$arg" in
    --no-rabbitmq) START_RABBIT=0 ;;
    --start) START_SERVICE=1 ;;
    -h|--help)
      echo "Usage: $0 [--start] [--no-rabbitmq]"
      exit 0
      ;;
  esac
done

echo
log "PropMv local notification setup"
echo

# ── 1. Start Redis (+ RabbitMQ by default) ─────────────────────────────────────
if [[ "$START_RABBIT" == "1" ]]; then
  bash "${SCRIPT_DIR}/setup-local-infra.sh" --with-rabbitmq
else
  bash "${SCRIPT_DIR}/setup-local-infra.sh"
fi

# ── 2. Sync env from backend ──────────────────────────────────────────────────
log "Syncing notification env from backend..."
node "${SCRIPT_DIR}/sync-notification-env.js"

# ── 3. Install dependencies ───────────────────────────────────────────────────
log "Installing notification-service dependencies..."
cd "$NOTIF_DIR"
npm ci

# ── 4. Optional start ─────────────────────────────────────────────────────────
echo
log "Setup complete."
echo
echo "  Backend dir       : ${BACKEND_DIR}"
echo "  Notification env  : ${NOTIF_DIR}/.env"
echo "  Redis             : redis://127.0.0.1:6379"
if [[ "$START_RABBIT" == "1" ]]; then
  echo "  RabbitMQ          : amqp://guest:guest@127.0.0.1:5672"
else
  echo "  RabbitMQ          : skipped (service uses DB fallback without it)"
fi
echo
echo "Start the backend (terminal 1):"
echo "  cd ${BACKEND_DIR} && npm run dev"
echo
if [[ "$START_SERVICE" == "1" ]]; then
  log "Starting notification service on port 3000..."
  npm run dev
else
  echo "Start the notification service (terminal 2):"
  echo "  cd ${NOTIF_DIR} && npm run dev"
  echo
  echo "Or re-run with --start to launch it now:"
  echo "  bash scripts/setup-notification-local.sh --start"
fi
echo
