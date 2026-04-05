#!/bin/bash
set -euo pipefail

# Load VPS config from .env or environment
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/.env" ]; then
  export $(grep -E '^(VPS_HOST|VPS_PROJECT_DIR|VPS_COURSES_DIR)=' "$PROJECT_DIR/.env" | xargs)
fi

VPS_HOST="${VPS_HOST:?VPS_HOST not set — add it to .env}"
VPS_PROJECT_DIR="${VPS_PROJECT_DIR:-/opt/lapibot-course-assistant}"
VPS_COURSES_DIR="${VPS_COURSES_DIR:-/opt/lapibot-courses}"

echo "Deploying to $VPS_HOST..."
ssh "$VPS_HOST" "cd $VPS_PROJECT_DIR && git pull && npm ci && npm run build && cd $VPS_COURSES_DIR && git pull && cd $VPS_PROJECT_DIR && docker compose --env-file .env -f docker/docker-compose.yml up -d --build"

echo "Deploy complete. Run 'npm run logs' to check."
