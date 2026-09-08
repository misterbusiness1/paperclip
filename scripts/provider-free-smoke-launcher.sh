#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'provider-free smoke launcher: %s\n' "$*" >&2
  exit 64
}

if [[ -n "${DATABASE_URL:-}" || -n "${DATABASE_MIGRATION_URL:-}" ]]; then
  die 'external database configuration is present; refusing process startup'
fi

# config.ts normally loads a repository-local .env after this launcher starts.
# Reject database bindings there, then disable cwd dotenv loading so a file
# created or changed after this preflight cannot rehydrate either binding.
cwd_env="$PWD/.env"
if [[ -f "$cwd_env" ]] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?(DATABASE_URL|DATABASE_MIGRATION_URL)[[:space:]]*=' "$cwd_env"; then
  die 'external database configuration is present in the launch cwd .env; refusing process startup'
fi

run_root="${PAPERCLIP_PROVIDER_FREE_RUN_ROOT:-}"
[[ -n "$run_root" ]] || die 'PAPERCLIP_PROVIDER_FREE_RUN_ROOT is required'
[[ "$run_root" == /* ]] || die 'PAPERCLIP_PROVIDER_FREE_RUN_ROOT must be an absolute path'
mkdir -p "$run_root"
run_root="$(cd "$run_root" && pwd -P)"

case "$run_root" in
  /|/paperclip|/paperclip/instances|/paperclip/instances/default)
    die 'PAPERCLIP_PROVIDER_FREE_RUN_ROOT is too broad'
    ;;
esac

home="$run_root/home"
config="$run_root/config.json"
context="$run_root/context.json"
if [[ -n "$(find "$run_root" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  die 'run root is not empty; refusing non-fresh startup'
fi
mkdir -p "$home"

# Fresh, run-owned paths prevent a repo-local or operator config from supplying
# config.database.connectionString after the DATABASE_URL guard has passed.
export PAPERCLIP_HOME="$home"
export PAPERCLIP_CONFIG="$config"
export PAPERCLIP_CONTEXT="$context"
export PAPERCLIP_INSTANCE_ID="provider-free-smoke"
export PAPERCLIP_DEPLOYMENT_MODE="local_trusted"
export PAPERCLIP_DEPLOYMENT_EXPOSURE="private"
export HOST="127.0.0.1"
export PAPERCLIP_DB_BACKUP_ENABLED="false"
export PAPERCLIP_PROVIDER_FREE_DB_MODE="embedded"
export PAPERCLIP_DISABLE_CWD_ENV="true"
unset DATABASE_URL DATABASE_MIGRATION_URL

printf 'provider-free isolation attestation: db=embedded home=%s config=%s\n' "$home" "$config"

if [[ "${1:-}" == "--" ]]; then
  shift
fi
if (( $# == 0 )); then
  set -- pnpm dev:once
fi

exec "$@"
