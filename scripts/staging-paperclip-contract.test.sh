#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
compose="$repo_root/docker/staging/compose.yml"

grep -q '127.0.0.1:${PAPERCLIP_STAGING_PORT' "$compose"
grep -q '${PAPERCLIP_STAGING_PROJECT}_db' "$compose"
grep -q '${PAPERCLIP_STAGING_PROJECT}_runtime' "$compose"
grep -q '${PAPERCLIP_STAGING_PROJECT}_network' "$compose"
grep -q 'PAPERCLIP_DEPLOYMENT_MODE: authenticated' "$compose"
grep -q 'resources:' "$compose"
grep -q 'healthcheck:' "$compose"
! grep -Eq '(/paperclip/instances/default|onecli|\.config/gh|woocommerce|customer|production.*volume)' "$compose"
bash -n "$repo_root/scripts/staging-paperclip-deploy.sh"
bash -n "$repo_root/scripts/staging-paperclip-bootstrap.sh"
bash -n "$repo_root/scripts/staging-paperclip-teardown.sh"
echo 'staging Paperclip isolation contract: PASS'
