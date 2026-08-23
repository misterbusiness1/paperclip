#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
compose="$repo_root/docker/staging/compose.yml"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-staging-contract.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin" "$test_dir/secrets"
touch "$test_dir/calls"

for command in docker curl; do
  cat >"$test_dir/bin/$command" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$(basename "$0") $*" >>"$STAGING_TEST_CALLS"
exit 97
MOCK
  chmod +x "$test_dir/bin/$command"
done

assert_rejected_without_mutation() {
  local script="$1"
  shift
  : >"$test_dir/calls"
  if timeout 5 env PATH="$test_dir/bin:$PATH" STAGING_TEST_CALLS="$test_dir/calls" "$@" bash "$repo_root/scripts/$script" >/dev/null 2>&1; then
    echo "expected rejection: $script" >&2
    exit 1
  fi
  [[ ! -s "$test_dir/calls" ]] || { echo "rejected input invoked Docker/curl: $script" >&2; cat "$test_dir/calls" >&2; exit 1; }
}

grep -q '127.0.0.1:${PAPERCLIP_STAGING_PORT' "$compose"
grep -q '${PAPERCLIP_STAGING_PROJECT}_db' "$compose"
grep -q '${PAPERCLIP_STAGING_PROJECT}_runtime' "$compose"
grep -q '${PAPERCLIP_STAGING_PROJECT}_network' "$compose"
grep -q 'PAPERCLIP_DEPLOYMENT_MODE: authenticated' "$compose"
grep -q 'pull_policy: never' "$compose"
grep -q 'pgvector/pgvector:pg16' "$compose"
grep -q 'PAPERCLIP_AUTH_DISABLE_SIGN_UP:' "$compose"
! grep -q '/usr/local/bin/docker-entrypoint.sh' "$compose"
grep -q 'resources:' "$compose"
grep -q 'healthcheck:' "$compose"
! grep -Eq '(/paperclip/instances/default|onecli|\.config/gh|woocommerce|customer|production.*volume)' "$compose"
bash -n "$repo_root/scripts/staging-paperclip-deploy.sh"
bash -n "$repo_root/scripts/staging-paperclip-bootstrap.sh"
bash -n "$repo_root/scripts/staging-paperclip-teardown.sh"

# Render the effective model with value-free fixture paths. This proves the
# project/resource names, loopback port, pull policy, limits, and auth flag as
# Compose interprets them rather than merely grepping source YAML.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  rendered="$(PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging \
    PAPERCLIP_STAGING_IMAGE=ghcr.io/oxfordcigar/paperclip:0000000000000000000000000000000000000000 \
    PAPERCLIP_STAGING_SECRET_DIR="$test_dir/secrets" \
    PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310 \
    PAPERCLIP_STAGING_AUTH_DISABLE_SIGN_UP=true \
    docker compose -f "$compose" config --format json)"
  jq -e '
    .name == "occ-paperclip-staging" and
    .services.server.pull_policy == "never" and
    .services.server.environment.PAPERCLIP_AUTH_DISABLE_SIGN_UP == "true" and
    .services.server.ports[0].host_ip == "127.0.0.1" and
    .services.server.deploy.resources.limits.memory == "3221225472" and
    .services.db.image == "pgvector/pgvector:pg16" and
    .volumes["staging-db"].name == "occ-paperclip-staging_db" and
    .networks.staging.name == "occ-paperclip-staging_network"
  ' >/dev/null <<<"$rendered"
else
  echo 'staging Paperclip Compose render: SKIP (Docker Compose unavailable)'
fi

common=(
  PAPERCLIP_STAGING_COMMIT="$(git -C "$repo_root" rev-parse HEAD)"
  PAPERCLIP_PRODUCTION_PROJECT=paperclip
  PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging
  PAPERCLIP_STAGING_PORT=3310
  PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310
  PAPERCLIP_STAGING_SECRET_DIR="$test_dir/secrets"
  PAPERCLIP_STAGING_ADMIN_PASSWORD=synthetic-test-only
)

assert_rejected_without_mutation staging-paperclip-deploy.sh "${common[@]}" PAPERCLIP_PRODUCTION_PROJECT=dummy-production
assert_rejected_without_mutation staging-paperclip-deploy.sh "${common[@]}" PAPERCLIP_STAGING_PROJECT=paperclip
assert_rejected_without_mutation staging-paperclip-deploy.sh "${common[@]}" PAPERCLIP_STAGING_PROJECT=bad-staging-name
assert_rejected_without_mutation staging-paperclip-bootstrap.sh "${common[@]}" PAPERCLIP_STAGING_PUBLIC_URL=https://production.example.test
assert_rejected_without_mutation staging-paperclip-bootstrap.sh "${common[@]}" PAPERCLIP_STAGING_SECRET_DIR="$test_dir/secrets/../secrets"
assert_rejected_without_mutation staging-paperclip-teardown.sh "${common[@]}" PAPERCLIP_STAGING_PROJECT=paperclip

# Exercise the failure trap with a valid preflight and a prior staging stack.
# Each adversarial case must reach mutation, stay staging-scoped, restore the
# prior image/data, and leave a machine-readable, value-free terminal receipt.
fixture="$test_dir/repo"
mkdir -p "$fixture/scripts/lib" "$fixture/docker/staging" "$fixture/secrets" "$fixture/receipts"
cp "$repo_root/scripts/staging-paperclip-deploy.sh" "$fixture/scripts/"
cp "$repo_root/scripts/lib/staging-paperclip-guard.sh" "$fixture/scripts/lib/"
cp "$compose" "$fixture/docker/staging/compose.yml"
sed -i "s#PAPERCLIP_APPROVED_STAGING_SECRET_DIR=\"/run/occ-paperclip-staging\"#PAPERCLIP_APPROVED_STAGING_SECRET_DIR=\"$fixture/secrets\"#" "$fixture/scripts/lib/staging-paperclip-guard.sh"
printf 'fixture\n' >"$fixture/secrets/better-auth-secret"
printf 'fixture\n' >"$fixture/secrets/postgres-password"
chmod 700 "$fixture/secrets"
chmod 600 "$fixture/secrets/"*
git -C "$fixture" init -q
git -C "$fixture" config user.email test@example.test
git -C "$fixture" config user.name 'Contract Test'
git -C "$fixture" add .
git -C "$fixture" commit -qm fixture
fixture_commit="$(git -C "$fixture" rev-parse HEAD)"

cat >"$test_dir/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$STAGING_TEST_CALLS"
case "$*" in
  'ps --all --filter label=com.docker.compose.project=paperclip --format {{.ID}}') printf 'prod-1\n' ;;
  'inspect prod-1 --format {{.Id}} {{.Image}}')
    [[ "${STAGING_TEST_SCENARIO:-}" == identity-mismatch && -f "$STAGING_TEST_STATE/started" ]] && printf 'prod-2 image-prod\n' || printf 'prod-1 image-prod\n'
    ;;
  *' config --format json') jq -n --arg p occ-paperclip-staging '{name:$p,volumes:{"staging-db":{name:($p+"_db")},"staging-runtime":{name:($p+"_runtime")}},networks:{staging:{name:($p+"_network")}}}' ;;
  *' images -q server') printf 'prior-image\n' ;;
  'ps --all --filter label=com.docker.compose.project=occ-paperclip-staging --format {{.ID}}') printf 'staging-server\n' ;;
  'inspect --format {{index .Config.Labels "com.docker.compose.service"}} staging-server') printf 'server\n' ;;
  'volume inspect occ-paperclip-staging_db'|'volume inspect occ-paperclip-staging_runtime'|'network inspect occ-paperclip-staging_network') exit 1 ;;
  run*db.tgz*) : >"$STAGING_TEST_BACKUP_DIR/db.tgz" ;;
  run*runtime.tgz*) : >"$STAGING_TEST_BACKUP_DIR/runtime.tgz" ;;
  'image inspect ghcr.io/oxfordcigar/paperclip:'*' --format {{.Id}}') printf 'new-image\n' ;;
  'image inspect ghcr.io/oxfordcigar/paperclip:'*' --format {{index .Config.Labels "org.opencontainers.image.revision"}}') printf '%s\n' "$STAGING_TEST_COMMIT" ;;
  compose*' up -d --wait') : >"$STAGING_TEST_STATE/started" ;;
esac
MOCK
cat >"$test_dir/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$STAGING_TEST_CALLS"
[[ "${STAGING_TEST_SCENARIO:-}" == health-failure ]] && printf '{"status":"bad"}\n' || printf '{"status":"ok"}\n'
MOCK
cat >"$test_dir/bin/timeout" <<'MOCK'
#!/usr/bin/env bash
seconds="$1"; shift
printf 'timeout %s %s\n' "$seconds" "$*" >>"$STAGING_TEST_CALLS"
case "${STAGING_TEST_SCENARIO:-}:$*" in
  build-timeout:'docker build '*) exit 124 ;;
  start-timeout:'docker compose '*' up -d --wait')
    if [[ ! -f "$STAGING_TEST_STATE/start-failed" ]]; then : >"$STAGING_TEST_STATE/start-failed"; exit 124; fi
    ;;
esac
"$@"
MOCK
chmod +x "$test_dir/bin/docker" "$test_dir/bin/curl" "$test_dir/bin/timeout"

assert_failed_deploy() {
  local scenario="$1" receipt="$fixture/receipts/$fixture_commit.failed.json"
  rm -f "$receipt" "$test_dir/started" "$test_dir/start-failed"
  : >"$test_dir/calls"
  if env PATH="$test_dir/bin:$PATH" STAGING_TEST_CALLS="$test_dir/calls" \
    STAGING_TEST_SCENARIO="$scenario" STAGING_TEST_STATE="$test_dir" \
    STAGING_TEST_BACKUP_DIR="$fixture/receipts/$fixture_commit.predeploy-data" \
    STAGING_TEST_COMMIT="$fixture_commit" PAPERCLIP_STAGING_COMMIT="$fixture_commit" \
    PAPERCLIP_PRODUCTION_PROJECT=paperclip PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging \
    PAPERCLIP_STAGING_PORT=3310 PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310 \
    PAPERCLIP_STAGING_SECRET_DIR="$fixture/secrets" PAPERCLIP_STAGING_RECEIPT_DIR="$fixture/receipts" \
    PAPERCLIP_STAGING_BUILD_TIMEOUT_SECONDS=60 PAPERCLIP_STAGING_START_TIMEOUT_SECONDS=30 \
    bash "$fixture/scripts/staging-paperclip-deploy.sh" >/dev/null 2>&1; then
    echo "expected deploy failure: $scenario" >&2; exit 1
  fi
  if [[ "$scenario" == build-timeout ]]; then
    jq -e --arg c "$fixture_commit" '.status=="failed" and .commit==$c and .rollback=="not-required" and (keys|sort)==["commit","composeProject","failedStep","rollback","status"]' "$receipt" >/dev/null
    ! grep -Eq 'compose .* (stop|down|up)' "$test_dir/calls"
    return
  fi
  jq -e --arg c "$fixture_commit" '.status=="failed" and .commit==$c and .composeProject=="occ-paperclip-staging" and (.failedStep|test("^line-[0-9]+$")) and .rollback=="prior-image-and-data-restored" and (keys|sort)==["commit","composeProject","failedStep","rollback","status"]' "$receipt" >/dev/null
  ! grep -q 'compose -p paper .*\(down\|up\|build\|run\|tag\)' "$test_dir/calls"
  stop_line="$(grep -n 'compose -p occ-paperclip-staging .* stop$' "$test_dir/calls" | head -1 | cut -d: -f1)"
  backup_line="$(grep -n 'run --pull never .*:/source:ro' "$test_dir/calls" | head -1 | cut -d: -f1)"
  failed_up_line="$(grep -n 'compose -p occ-paperclip-staging .* up -d --wait' "$test_dir/calls" | head -1 | cut -d: -f1)"
  down_line="$(grep -n 'compose -p occ-paperclip-staging .* down --remove-orphans' "$test_dir/calls" | head -1 | cut -d: -f1)"
  restore_line="$(grep -n 'run --pull never .*:/restore' "$test_dir/calls" | head -1 | cut -d: -f1)"
  restart_line="$(grep -n 'compose -p occ-paperclip-staging .* up -d --wait' "$test_dir/calls" | tail -1 | cut -d: -f1)"
  (( stop_line < backup_line && backup_line < failed_up_line && failed_up_line < down_line && down_line < restore_line && restore_line < restart_line ))
  grep -q 'timeout 120 docker compose -p occ-paperclip-staging .* down --remove-orphans' "$test_dir/calls"
  ! grep -q 'docker image tag prior-image' "$test_dir/calls"
  grep -q 'timeout 180 docker compose -p occ-paperclip-staging .* up -d --wait' "$test_dir/calls"
}

assert_failed_deploy build-timeout
assert_failed_deploy start-timeout
assert_failed_deploy identity-mismatch
assert_failed_deploy health-failure
echo 'staging Paperclip isolation contract: PASS'
