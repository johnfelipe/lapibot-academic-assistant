#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/.env" ]; then
  export $(grep -E '^(VPS_HOST|VPS_PROJECT_DIR)=' "$PROJECT_DIR/.env" | xargs)
fi

VPS_HOST="${VPS_HOST:?VPS_HOST not set — add it to .env}"
VPS_PROJECT_DIR="${VPS_PROJECT_DIR:-/opt/lapibot-course-assistant}"

ssh "$VPS_HOST" "cd $VPS_PROJECT_DIR && docker compose --env-file .env -f docker/docker-compose.yml logs -f app"
