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

mkdir -p "$test_root/stale/home"
if env -u DATABASE_URL -u DATABASE_MIGRATION_URL \
  PAPERCLIP_PROVIDER_FREE_RUN_ROOT="$test_root/stale" \
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
    test "$PAPERCLIP_DEPLOYMENT_MODE" = local_trusted
    test "$HOST" = 127.0.0.1
    printf "%s\n%s\n%s\n" "$PAPERCLIP_HOME" "$PAPERCLIP_CONFIG" "$PAPERCLIP_CONTEXT" >"$1"
  ' sh "$capture" >/dev/null

expected_root="$(cd "$test_root/positive" && pwd -P)"
while IFS= read -r path; do
  [[ "$path" == "$expected_root"/* ]] || fail "non-isolated child path: $path"
done <"$capture"

printf 'provider-free launcher contract: PASS\n'
