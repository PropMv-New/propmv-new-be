#!/usr/bin/env bash
set -euo pipefail

# PropMv local infrastructure: Redis + optional RabbitMQ
#
# Usage (from propmv/):
#   bash scripts/setup-local-infra.sh
#   bash scripts/setup-local-infra.sh --with-rabbitmq

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${BACKEND_DIR}"

START_RABBIT=0
if [[ "${1:-}" == "--with-rabbitmq" || "${1:-}" == "rabbitmq" ]]; then
  START_RABBIT=1
fi

echo
echo "=== PropMv local infra setup (Linux/macOS) ==="
echo

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

wait_for_redis() {
  local i
  for i in $(seq 1 20); do
    if docker exec propmv-redis redis-cli ping 2>/dev/null | grep -q PONG; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_redis_docker() {
  if docker inspect propmv-redis >/dev/null 2>&1; then
    docker start propmv-redis >/dev/null
  else
    docker run -d --name propmv-redis --restart unless-stopped -p 6379:6379 redis:7-alpine >/dev/null
  fi
  wait_for_redis
}

start_redis_native() {
  if have_cmd systemctl; then
    sudo systemctl enable --now redis-server 2>/dev/null || sudo systemctl enable --now redis 2>/dev/null || true
  elif have_cmd service; then
    sudo service redis-server start 2>/dev/null || sudo service redis start 2>/dev/null || true
  fi
  if have_cmd redis-cli && redis-cli ping 2>/dev/null | grep -q PONG; then
    return 0
  fi
  return 1
}

if have_cmd docker && docker info >/dev/null 2>&1; then
  echo "Starting Redis on 127.0.0.1:6379 via Docker..."
  start_redis_docker
  echo "[OK] Redis is ready at redis://127.0.0.1:6379"
elif have_cmd redis-cli && redis-cli ping 2>/dev/null | grep -q PONG; then
  echo "[OK] Redis is already running"
elif have_cmd apt-get; then
  echo "Docker is not available. Installing redis-server via apt..."
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y redis-server
  start_redis_native
  echo "[OK] Redis is ready at redis://127.0.0.1:6379"
else
  echo "[ERROR] Neither Docker nor a native Redis install is available."
  echo "Install Docker (recommended) or redis-server, then re-run this script."
  exit 1
fi

if [[ "${START_RABBIT}" == "1" ]]; then
  if have_cmd docker && docker info >/dev/null 2>&1; then
    echo "Starting RabbitMQ on 127.0.0.1:5672 via Docker..."
    if docker inspect propmv-rabbitmq >/dev/null 2>&1; then
      docker start propmv-rabbitmq >/dev/null
    else
      docker run -d --name propmv-rabbitmq --restart unless-stopped \
        -p 5672:5672 -p 15672:15672 \
        -e RABBITMQ_DEFAULT_USER=guest \
        -e RABBITMQ_DEFAULT_PASS=guest \
        rabbitmq:3-management-alpine >/dev/null
    fi
    echo "[OK] RabbitMQ container started (management UI http://127.0.0.1:15672)"
  else
    echo "[WARN] --with-rabbitmq requested but Docker is not running. Skipping RabbitMQ."
  fi
else
  echo "Skipping RabbitMQ. The notification service can run without it."
  echo "To also start RabbitMQ: bash scripts/setup-local-infra.sh --with-rabbitmq"
fi

echo
echo "Set REDIS_URL=redis://127.0.0.1:6379 in .env.local and notification-service/.env"
echo
