#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/lib/staging-paperclip-guard.sh"
: "${PAPERCLIP_STAGING_PROJECT:=occ-paperclip-staging}"
: "${PAPERCLIP_PRODUCTION_PROJECT:?set PAPERCLIP_PRODUCTION_PROJECT}"
: "${PAPERCLIP_STAGING_SECRET_DIR:?set PAPERCLIP_STAGING_SECRET_DIR}"
: "${PAPERCLIP_STAGING_PORT:=3310}"
export PAPERCLIP_STAGING_PROJECT PAPERCLIP_STAGING_SECRET_DIR
export PAPERCLIP_STAGING_IMAGE="${PAPERCLIP_STAGING_IMAGE:-unused:staging}"
export PAPERCLIP_STAGING_PUBLIC_URL="${PAPERCLIP_STAGING_PUBLIC_URL:-http://127.0.0.1:3310}"
require_staging_preflight
docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$repo_root/docker/staging/compose.yml" down --remove-orphans
if [[ "${PAPERCLIP_STAGING_DELETE_DATA:-false}" == "true" ]]; then
  docker volume rm "${PAPERCLIP_STAGING_PROJECT}_db" "${PAPERCLIP_STAGING_PROJECT}_runtime"
fi
