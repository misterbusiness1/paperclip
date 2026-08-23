#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
compose_file="$repo_root/docker/staging/compose.yml"
: "${PAPERCLIP_STAGING_COMMIT:?set the full commit SHA to deploy}"
: "${PAPERCLIP_STAGING_PROJECT:=occ-paperclip-staging}"
: "${PAPERCLIP_PRODUCTION_PROJECT:?set the exact production Compose project name for the read-only parity proof}"
: "${PAPERCLIP_STAGING_PORT:=3310}"
: "${PAPERCLIP_STAGING_PUBLIC_URL:=http://127.0.0.1:${PAPERCLIP_STAGING_PORT}}"
: "${PAPERCLIP_STAGING_SECRET_DIR:?set a host directory containing secret files}"

[[ "$PAPERCLIP_STAGING_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be a full 40-character SHA" >&2; exit 2; }
git -C "$repo_root" cat-file -e "$PAPERCLIP_STAGING_COMMIT^{commit}"
[[ "$(git -C "$repo_root" rev-parse "$PAPERCLIP_STAGING_COMMIT^{commit}")" == "$PAPERCLIP_STAGING_COMMIT" ]]
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$PAPERCLIP_STAGING_COMMIT" ]] || { echo "checked-out HEAD does not match PAPERCLIP_STAGING_COMMIT" >&2; exit 2; }
for file in better-auth-secret postgres-password; do
  [[ -s "$PAPERCLIP_STAGING_SECRET_DIR/$file" ]] || { echo "missing staging secret file: $file" >&2; exit 2; }
done

export PAPERCLIP_STAGING_PROJECT PAPERCLIP_STAGING_PORT PAPERCLIP_STAGING_PUBLIC_URL PAPERCLIP_STAGING_SECRET_DIR
export PAPERCLIP_STAGING_IMAGE="ghcr.io/oxfordcigar/paperclip:${PAPERCLIP_STAGING_COMMIT}"
receipt_dir="${PAPERCLIP_STAGING_RECEIPT_DIR:-$repo_root/staging-receipts}"
mkdir -p "$receipt_dir"
receipt="$receipt_dir/${PAPERCLIP_STAGING_COMMIT}.json"

snapshot_production() {
  docker ps --all --filter "label=com.docker.compose.project=$PAPERCLIP_PRODUCTION_PROJECT" --format '{{.ID}}' | sort | while read -r id; do
    [[ -n "$id" ]] || continue
    docker inspect "$id" --format '{{.Id}} {{.Image}}'
  done
}

before_prod="$(snapshot_production)"
before_digest="$(docker image inspect "$PAPERCLIP_STAGING_IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"

docker build --pull --target production \
  --build-arg "PAPERCLIP_BUILD_COMMIT=$PAPERCLIP_STAGING_COMMIT" \
  --build-arg "PAPERCLIP_BUILD_VERSION=staging-$PAPERCLIP_STAGING_COMMIT" \
  --label "org.opencontainers.image.revision=$PAPERCLIP_STAGING_COMMIT" \
  --tag "$PAPERCLIP_STAGING_IMAGE" "$repo_root"
docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" config --quiet
docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" up -d --wait

after_prod="$(snapshot_production)"
[[ "$before_prod" == "$after_prod" ]] || { echo "production container identity changed; stop and investigate" >&2; exit 1; }
after_digest="$(docker image inspect "$PAPERCLIP_STAGING_IMAGE" --format '{{.Id}}')"
health="$(curl --fail --silent "$PAPERCLIP_STAGING_PUBLIC_URL/api/health" | jq -r .status)"

jq -n \
  --arg commit "$PAPERCLIP_STAGING_COMMIT" \
  --arg project "$PAPERCLIP_STAGING_PROJECT" \
  --arg endpoint "$PAPERCLIP_STAGING_PUBLIC_URL" \
  --arg preImageDigest "$before_digest" \
  --arg postImageDigest "$after_digest" \
  --arg health "$health" \
  --arg productionProject "$PAPERCLIP_PRODUCTION_PROJECT" \
  --arg productionStateSha256 "$(printf '%s' "$after_prod" | sha256sum | cut -d' ' -f1)" \
  '{commit:$commit,composeProject:$project,privateEndpoint:$endpoint,preImageDigest:$preImageDigest,postImageDigest:$postImageDigest,health:$health,productionProject:$productionProject,productionStateSha256:$productionStateSha256}' \
  >"$receipt"
echo "staging deploy receipt: $receipt"
