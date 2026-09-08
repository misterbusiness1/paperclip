#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
launcher="$repo_root/scripts/provider-free-smoke-launcher.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/provider-free-launcher.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fail() {
  printf 'provider-free launcher contract: %s\n' "$*" >&2
  exit 1
}

bash -n "$launcher"

# Negative contract: inherited external DB configuration must stop before the
# child process can execute.
marker="$test_root/negative-started"
if DATABASE_URL='postgres://external.invalid/paperclip' \
  PAPERCLIP_PROVIDER_FREE_RUN_ROOT="$test_root/negative" \
  "$launcher" -- sh -c ': >"$1"' sh "$marker" >/dev/null 2>&1; then
  fail 'inherited DATABASE_URL was accepted'
fi
[[ ! -e "$marker" ]] || fail 'child process started with inherited DATABASE_URL'

if DATABASE_MIGRATION_URL='postgres://external.invalid/paperclip' \
  PAPERCLIP_PROVIDER_FREE_RUN_ROOT="$test_root/negative-migration" \
  "$launcher" -- sh -c ': >"$1"' sh "$marker" >/dev/null 2>&1; then
  fail 'inherited DATABASE_MIGRATION_URL was accepted'
fi
[[ ! -e "$marker" ]] || fail 'child process started with inherited DATABASE_MIGRATION_URL'

# A cwd-local dotenv database binding must fail before the child starts. This
# covers the config.ts load that occurs after the launcher's inherited-env guard.
for binding in DATABASE_URL DATABASE_MIGRATION_URL; do
  dotenv_cwd="$test_root/dotenv-cwd-$binding"
  dotenv_run="$test_root/dotenv-run-$binding"
  mkdir -p "$dotenv_cwd" "$dotenv_run"
  printf '%s=postgres://external.invalid/paperclip\n' "$binding" >"$dotenv_cwd/.env"
  if (cd "$dotenv_cwd" && \
    env -u DATABASE_URL -u DATABASE_MIGRATION_URL \
    PAPERCLIP_PROVIDER_FREE_RUN_ROOT="$dotenv_run" \
    "$launcher" -- sh -c ': >"$1"' sh "$marker" >/dev/null 2>&1); then
    fail "launch cwd .env $binding was accepted"
  fi
  [[ ! -e "$marker" ]] || fail "child process started with launch cwd .env $binding"
done

for stale_name in context.json arbitrary-marker; do
  stale_root="$test_root/stale-$stale_name"
  mkdir -p "$stale_root"
  : >"$stale_root/$stale_name"
  if env -u DATABASE_URL -u DATABASE_MIGRATION_URL \
    PAPERCLIP_PROVIDER_FREE_RUN_ROOT="$stale_root" \
    "$launcher" -- sh -c ': >"$1"' sh "$marker" >/dev/null 2>&1; then
    fail "non-empty run root containing $stale_name was accepted"
  fi
  [[ ! -e "$marker" ]] || fail "child process started with $stale_name in run root"
done

mkdir -p "$test_root/stale-home/home"
if env -u DATABASE_URL -u DATABASE_MIGRATION_URL \
  PAPERCLIP_PROVIDER_FREE_RUN_ROOT="$test_root/stale-home" \
  "$launcher" -- sh -c ': >"$1"' sh "$marker" >/dev/null 2>&1; then
  fail 'prior Paperclip state was accepted'
fi
[[ ! -e "$marker" ]] || fail 'child process started with prior Paperclip state'

# Positive isolated-start contract: the child sees no database URL, and every
# config/database discovery path is rooted in the run-owned directory.
capture="$test_root/positive.env"
env -u DATABASE_URL -u DATABASE_MIGRATION_URL \
  PAPERCLIP_PROVIDER_FREE_RUN_ROOT="$test_root/positive" \
  "$launcher" -- sh -c '
    test -z "${DATABASE_URL+x}"
    test -z "${DATABASE_MIGRATION_URL+x}"
    test "$PAPERCLIP_PROVIDER_FREE_DB_MODE" = embedded
    test "$PAPERCLIP_DISABLE_CWD_ENV" = true
    test "$PAPERCLIP_DEPLOYMENT_MODE" = local_trusted
    test "$HOST" = 127.0.0.1
    printf "%s\n%s\n%s\n" "$PAPERCLIP_HOME" "$PAPERCLIP_CONFIG" "$PAPERCLIP_CONTEXT" >"$1"
  ' sh "$capture" >/dev/null

expected_root="$(cd "$test_root/positive" && pwd -P)"
while IFS= read -r path; do
  [[ "$path" == "$expected_root"/* ]] || fail "non-isolated child path: $path"
done <"$capture"

# Integration contract: even if a cwd .env appears after launcher preflight,
# config.ts must not rehydrate an external database binding.
late_cwd="$test_root/late-dotenv-cwd"
mkdir -p "$late_cwd"
(cd "$late_cwd" && \
  env -u DATABASE_URL -u DATABASE_MIGRATION_URL \
  PAPERCLIP_PROVIDER_FREE_RUN_ROOT="$test_root/late-dotenv-run" \
  "$launcher" -- sh -c '
    printf "DATABASE_URL=postgres://external.invalid/paperclip\nDATABASE_MIGRATION_URL=postgres://external.invalid/migrations\n" >.env
    exec "$1" "$2"
  ' sh "$repo_root/server/node_modules/.bin/tsx" "$repo_root/scripts/provider-free-smoke-config-probe.ts" >/dev/null)

printf 'provider-free launcher contract: PASS\n'
