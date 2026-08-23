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
  PAPERCLIP_STAGING_SECRET_DIR="$resolved"
  export PAPERCLIP_STAGING_SECRET_DIR
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
