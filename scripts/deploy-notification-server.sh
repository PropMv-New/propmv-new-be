#!/usr/bin/env bash
# One-command notification deploy - run from the backend repo root (~/propmv):
#   cd ~/propmv && git pull && bash scripts/deploy-notification-server.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export WITH_RABBITMQ=1
export RELOAD_BACKEND=1

exec bash "${SCRIPT_DIR}/deploy-notification-service.sh" "$@"
