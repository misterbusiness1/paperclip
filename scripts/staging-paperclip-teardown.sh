#!/usr/bin/env bash
set -euo pipefail
: "${PAPERCLIP_STAGING_PROJECT:=occ-paperclip-staging}"
: "${PAPERCLIP_STAGING_SECRET_DIR:?set PAPERCLIP_STAGING_SECRET_DIR}"
export PAPERCLIP_STAGING_PROJECT PAPERCLIP_STAGING_SECRET_DIR
export PAPERCLIP_STAGING_IMAGE="${PAPERCLIP_STAGING_IMAGE:-unused:staging}"
export PAPERCLIP_STAGING_PUBLIC_URL="${PAPERCLIP_STAGING_PUBLIC_URL:-http://127.0.0.1:3310}"
docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "${PAPERCLIP_STAGING_COMPOSE_FILE:-docker/staging/compose.yml}" down --remove-orphans
if [[ "${PAPERCLIP_STAGING_DELETE_DATA:-false}" == "true" ]]; then
  docker volume rm "${PAPERCLIP_STAGING_PROJECT}_db" "${PAPERCLIP_STAGING_PROJECT}_runtime"
fi
