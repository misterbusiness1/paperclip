#!/usr/bin/env bash

PAPERCLIP_APPROVED_STAGING_PROJECT="occ-paperclip-staging"
PAPERCLIP_APPROVED_STAGING_SECRET_DIR="/run/occ-paperclip-staging"

staging_die() {
  printf 'staging isolation preflight: %s\n' "$1" >&2
  return 2
}

require_staging_project() {
  local staging_project="${PAPERCLIP_STAGING_PROJECT:-}"
  local production_project="${PAPERCLIP_PRODUCTION_PROJECT:-}"

  [[ -n "$production_project" ]] || { staging_die "production project identity is required"; return 2; }
  [[ "$production_project" == "paperclip" ]] || { staging_die "production project must be exactly paperclip"; return 2; }
  [[ "$staging_project" == "$PAPERCLIP_APPROVED_STAGING_PROJECT" ]] || { staging_die "unapproved staging project"; return 2; }
  [[ "$staging_project" != "$production_project" ]] || { staging_die "staging and production projects must differ"; return 2; }
}

require_loopback_staging_url() {
  local expected="http://127.0.0.1:${PAPERCLIP_STAGING_PORT:-3310}"
  [[ "${PAPERCLIP_STAGING_PUBLIC_URL:-}" == "$expected" ]] || { staging_die "public URL must be exactly $expected"; return 2; }
}

require_staging_secret_dir() {
  local requested="${PAPERCLIP_STAGING_SECRET_DIR:-}"
  local resolved
  [[ -n "$requested" ]] || { staging_die "staging secret directory is required"; return 2; }
  [[ -d "$requested" ]] || { staging_die "staging secret directory does not exist"; return 2; }
  resolved="$(realpath -e -- "$requested")" || { staging_die "cannot resolve staging secret directory"; return 2; }
  [[ "$resolved" == "$PAPERCLIP_APPROVED_STAGING_SECRET_DIR" ]] || { staging_die "unapproved staging secret directory"; return 2; }
  [[ "$(stat -c '%a' "$resolved")" == "700" ]] || { staging_die "staging secret directory must have mode 0700"; return 2; }
  [[ "$(stat -c '%u' "$resolved")" == "$(id -u)" ]] || { staging_die "staging secret directory must be owned by the deploy user"; return 2; }
  local secret_file
  for secret_file in better-auth-secret postgres-password; do
    [[ -f "$resolved/$secret_file" && ! -L "$resolved/$secret_file" ]] || { staging_die "required staging secret file is missing or not regular"; return 2; }
    [[ "$(stat -c '%a' "$resolved/$secret_file")" == "600" ]] || { staging_die "staging secret files must have mode 0600"; return 2; }
    [[ "$(stat -c '%u' "$resolved/$secret_file")" == "$(id -u)" ]] || { staging_die "staging secret files must be owned by the deploy user"; return 2; }
  done
  PAPERCLIP_STAGING_SECRET_DIR="$resolved"
  export PAPERCLIP_STAGING_SECRET_DIR
}

require_staging_resource_labels() {
  local container service volume network
  while read -r container; do
    [[ -z "$container" ]] && continue
    service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")"
    [[ "$service" == "db" || "$service" == "server" ]] || { staging_die "unexpected container in staging project"; return 2; }
  done < <(docker ps --all --filter "label=com.docker.compose.project=$PAPERCLIP_APPROVED_STAGING_PROJECT" --format '{{.ID}}')
  for volume in "${PAPERCLIP_APPROVED_STAGING_PROJECT}_db" "${PAPERCLIP_APPROVED_STAGING_PROJECT}_runtime"; do
    docker volume inspect "$volume" >/dev/null 2>&1 || continue
    [[ "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume")" == "$PAPERCLIP_APPROVED_STAGING_PROJECT" ]] || { staging_die "staging volume lacks the approved project label"; return 2; }
  done
  network="${PAPERCLIP_APPROVED_STAGING_PROJECT}_network"
  if docker network inspect "$network" >/dev/null 2>&1; then
    [[ "$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "$network")" == "$PAPERCLIP_APPROVED_STAGING_PROJECT" ]] || { staging_die "staging network lacks the approved project label"; return 2; }
  fi
}

require_staging_preflight() {
  require_staging_project
  require_loopback_staging_url
  require_staging_secret_dir
}

require_unchanged_production_identity() {
  local before="$1"
  local after="$2"
  [[ -n "$before" && "$before" == "$after" ]] || staging_die "production container identity changed or is empty"
}

require_staging_health() {
  [[ "$1" == "ok" ]] || staging_die "staging health check failed"
}
