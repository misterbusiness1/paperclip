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
  PAPERCLIP_PRODUCTION_PROJECT=paperclip-production
  PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging
  PAPERCLIP_STAGING_PORT=3310
  PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310
  PAPERCLIP_STAGING_SECRET_DIR="$test_dir/secrets"
  PAPERCLIP_STAGING_ADMIN_PASSWORD=synthetic-test-only
)

assert_rejected_without_mutation staging-paperclip-deploy.sh "${common[@]}" PAPERCLIP_STAGING_PROJECT=paperclip-production
assert_rejected_without_mutation staging-paperclip-deploy.sh "${common[@]}" PAPERCLIP_STAGING_PROJECT=bad-staging-name
assert_rejected_without_mutation staging-paperclip-bootstrap.sh "${common[@]}" PAPERCLIP_STAGING_PUBLIC_URL=https://production.example.test
assert_rejected_without_mutation staging-paperclip-bootstrap.sh "${common[@]}" PAPERCLIP_STAGING_SECRET_DIR="$test_dir/secrets/../secrets"
assert_rejected_without_mutation staging-paperclip-teardown.sh "${common[@]}" PAPERCLIP_STAGING_PROJECT=paperclip-production

# Post-start identity and health gates are pure fail-closed checks. Their
# failure cannot select or mutate a production resource, and the deploy EXIT
# trap below is statically required to use bounded staging-only rollback calls.
source "$repo_root/scripts/lib/staging-paperclip-guard.sh"
: >"$test_dir/calls"
! require_unchanged_production_identity 'container-a image-a' 'container-b image-b' >/dev/null 2>&1
! require_unchanged_production_identity '' '' >/dev/null 2>&1
! require_staging_health unhealthy >/dev/null 2>&1
[[ ! -s "$test_dir/calls" ]]

# Failure handling is bounded and covers both post-start gates. The negative
# cases above prove invalid inputs cannot reach either mutation client.
grep -q 'timeout 120 docker compose.*down' "$repo_root/scripts/staging-paperclip-deploy.sh"
grep -q 'timeout 180 docker compose.*up' "$repo_root/scripts/staging-paperclip-deploy.sh"
grep -q 'write_failure_receipt' "$repo_root/scripts/staging-paperclip-deploy.sh"
grep -q 'require_unchanged_production_identity.*before_prod.*after_prod' "$repo_root/scripts/staging-paperclip-deploy.sh"
grep -q 'require_staging_health.*health' "$repo_root/scripts/staging-paperclip-deploy.sh"
echo 'staging Paperclip isolation contract: PASS'
