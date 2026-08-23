#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
compose_file="$repo_root/docker/staging/compose.yml"
source "$repo_root/scripts/lib/staging-paperclip-guard.sh"
: "${PAPERCLIP_STAGING_COMMIT:?set the full commit SHA to deploy}"
: "${PAPERCLIP_STAGING_PROJECT:=occ-paperclip-staging}"
: "${PAPERCLIP_PRODUCTION_PROJECT:?set the exact production Compose project name for the read-only parity proof}"
: "${PAPERCLIP_STAGING_PORT:=3310}"
: "${PAPERCLIP_STAGING_PUBLIC_URL:=http://127.0.0.1:${PAPERCLIP_STAGING_PORT}}"
: "${PAPERCLIP_STAGING_SECRET_DIR:?set a host directory containing secret files}"

require_staging_preflight
[[ "$PAPERCLIP_STAGING_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be a full 40-character SHA" >&2; exit 2; }
git -C "$repo_root" cat-file -e "$PAPERCLIP_STAGING_COMMIT^{commit}"
[[ "$(git -C "$repo_root" rev-parse "$PAPERCLIP_STAGING_COMMIT^{commit}")" == "$PAPERCLIP_STAGING_COMMIT" ]]
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$PAPERCLIP_STAGING_COMMIT" ]] || { echo "checked-out HEAD does not match PAPERCLIP_STAGING_COMMIT" >&2; exit 2; }
for file in better-auth-secret postgres-password; do
  [[ -s "$PAPERCLIP_STAGING_SECRET_DIR/$file" ]] || { echo "missing staging secret file: $file" >&2; exit 2; }
done

export PAPERCLIP_STAGING_PROJECT PAPERCLIP_STAGING_PORT PAPERCLIP_STAGING_PUBLIC_URL PAPERCLIP_STAGING_SECRET_DIR
export PAPERCLIP_STAGING_IMAGE="ghcr.io/oxfordcigar/paperclip:${PAPERCLIP_STAGING_COMMIT}"
receipt_dir="$repo_root/staging-receipts"
[[ -z "${PAPERCLIP_STAGING_RECEIPT_DIR:-}" || "$PAPERCLIP_STAGING_RECEIPT_DIR" == "$receipt_dir" ]] \
  || { echo "receipt directory must be exactly $receipt_dir" >&2; exit 2; }
mkdir -p "$receipt_dir"
chmod 700 "$receipt_dir"
[[ "$(realpath -e -- "$receipt_dir")" == "$(realpath -e -- "$repo_root")/staging-receipts" ]] || { echo "receipt directory escaped the repository" >&2; exit 2; }
find "$receipt_dir" -mindepth 1 -maxdepth 1 -type d -name '*.predeploy-data.*' -mtime +7 -exec rm -rf -- {} +
receipt="$receipt_dir/${PAPERCLIP_STAGING_COMMIT}.json"
failure_receipt="$receipt_dir/${PAPERCLIP_STAGING_COMMIT}.failed.json"
backup_dir="$(mktemp -d "$receipt_dir/${PAPERCLIP_STAGING_COMMIT}.predeploy-data.XXXXXX")"
chmod 700 "$backup_dir"
deployment_phase="pre-mutation"
rollback_running=false
prior_image_id=""

snapshot_production() {
  docker ps --all --filter "label=com.docker.compose.project=$PAPERCLIP_PRODUCTION_PROJECT" --format '{{.ID}}' | sort | while read -r id; do
    [[ -n "$id" ]] || continue
    docker inspect "$id" --format '{{.Id}} {{.Image}}'
  done
}

before_prod="$(snapshot_production)"
[[ -n "$before_prod" ]] || { echo "production identity proof is empty; refusing staging mutation" >&2; exit 2; }
before_digest="$(docker image inspect "$PAPERCLIP_STAGING_IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"

# Resolve and prove every Compose-owned resource before the first mutating Docker command.
resolved_compose="$(docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" config --format json)"
jq -e --arg project "$PAPERCLIP_STAGING_PROJECT" '
  .name == $project and
  .volumes["staging-db"].name == ($project + "_db") and
  .volumes["staging-runtime"].name == ($project + "_runtime") and
  .networks.staging.name == ($project + "_network")
' >/dev/null <<<"$resolved_compose" || { echo "resolved Compose resources violate staging isolation" >&2; exit 2; }
require_staging_resource_labels
prior_image_id="$(docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" images -q server 2>/dev/null | head -1 || true)"

# Existing state is valid only when it is either completely absent or a full,
# restorable prior stack. Any orphan/partial resource set fails before mutation.
db_volume=false
runtime_volume=false
network_exists=false
db_container="$(docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" ps -a -q db 2>/dev/null | head -1 || true)"
server_container="$(docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" ps -a -q server 2>/dev/null | head -1 || true)"
docker volume inspect "${PAPERCLIP_STAGING_PROJECT}_db" >/dev/null 2>&1 && db_volume=true
docker volume inspect "${PAPERCLIP_STAGING_PROJECT}_runtime" >/dev/null 2>&1 && runtime_volume=true
docker network inspect "${PAPERCLIP_STAGING_PROJECT}_network" >/dev/null 2>&1 && network_exists=true
resource_count=0
for present in "$db_volume" "$runtime_volume" "$network_exists"; do [[ "$present" == true ]] && ((resource_count += 1)); done
[[ -n "$db_container" ]] && ((resource_count += 1))
[[ -n "$server_container" ]] && ((resource_count += 1))
if (( resource_count != 0 )); then
  [[ "$db_volume" == true && "$runtime_volume" == true && "$network_exists" == true \
    && -n "$db_container" && -n "$server_container" && -n "$prior_image_id" ]] \
    || { echo "staging resources are orphaned or incomplete; refusing mutation" >&2; exit 2; }
  inspected_prior_id="$(docker image inspect "$prior_image_id" --format '{{.Id}}' 2>/dev/null || true)"
  [[ -n "$inspected_prior_id" && "$inspected_prior_id" == "$prior_image_id" ]] \
    || { echo "prior staging image is not an immutable local image ID" >&2; exit 2; }
elif [[ -n "$prior_image_id" ]]; then
  echo "staging image exists without a coherent prior stack; refusing mutation" >&2
  exit 2
fi

write_failure_receipt() {
  local failed_step="$1"
  local rollback_result="$2"
  jq -n --arg commit "$PAPERCLIP_STAGING_COMMIT" --arg project "$PAPERCLIP_STAGING_PROJECT" \
    --arg failedStep "$failed_step" --arg rollback "$rollback_result" \
    '{status:"failed",commit:$commit,composeProject:$project,failedStep:$failedStep,rollback:$rollback}' >"$failure_receipt"
}

backup_volume() {
  local volume="$1"
  local archive="$2"
  timeout 120 docker run --pull never --rm --entrypoint sh --volume "$volume:/source:ro" --volume "$backup_dir:/backup" "$prior_image_id" \
    -c "cd /source && tar -czf /backup/$archive ."
  chmod 600 "$backup_dir/$archive"
}

restore_volume() {
  local volume="$1"
  local archive="$2"
  timeout 120 docker run --pull never --rm --entrypoint sh --volume "$volume:/restore" --volume "$backup_dir:/backup:ro" "$prior_image_id" \
    -c "find /restore -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -xzf /backup/$archive -C /restore"
}

rollback_failed_deploy() {
  local failed_step="line-$1"
  local result="not-required"
  [[ "$deployment_phase" != "pre-mutation" ]] || { write_failure_receipt "$failed_step" "$result"; return; }
  rollback_running=true
  if [[ "$deployment_phase" == "prior-stop-attempted" || "$deployment_phase" == "prior-stopped" ]]; then
    result="prior-restart-failed"
    if PAPERCLIP_STAGING_IMAGE="$prior_image_id" PAPERCLIP_STAGING_AUTH_DISABLE_SIGN_UP=true \
      timeout 180 docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" up -d --wait; then
      result="prior-stack-restarted-untouched"
    fi
  else
    result="teardown-failed"
    if timeout 120 docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" down --remove-orphans; then
      result="torn-down"
      if [[ -n "$prior_image_id" && -s "$backup_dir/db.tgz" && -s "$backup_dir/runtime.tgz" ]]; then
        if restore_volume "${PAPERCLIP_STAGING_PROJECT}_db" db.tgz \
          && restore_volume "${PAPERCLIP_STAGING_PROJECT}_runtime" runtime.tgz \
          && PAPERCLIP_STAGING_IMAGE="$prior_image_id" PAPERCLIP_STAGING_AUTH_DISABLE_SIGN_UP=true \
            timeout 180 docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" up -d --wait; then
          result="prior-image-and-data-restored"
        else
          result="restore-failed-stack-left-down"
          timeout 60 docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" down --remove-orphans || true
        fi
      fi
    fi
  fi
  write_failure_receipt "$failed_step" "$result"
}
trap 'status=$?; if (( status != 0 )) && [[ "$rollback_running" != true ]]; then rollback_failed_deploy "$LINENO" || true; fi; exit "$status"' EXIT

build_timeout="${PAPERCLIP_STAGING_BUILD_TIMEOUT_SECONDS:-900}"
start_timeout="${PAPERCLIP_STAGING_START_TIMEOUT_SECONDS:-300}"
[[ "$build_timeout" =~ ^[0-9]+$ && "$build_timeout" -ge 60 && "$build_timeout" -le 1800 ]] || { echo "invalid build timeout" >&2; exit 2; }
[[ "$start_timeout" =~ ^[0-9]+$ && "$start_timeout" -ge 30 && "$start_timeout" -le 600 ]] || { echo "invalid start timeout" >&2; exit 2; }
timeout "$build_timeout" docker build --pull --target production \
  --build-arg "PAPERCLIP_BUILD_COMMIT=$PAPERCLIP_STAGING_COMMIT" \
  --build-arg "PAPERCLIP_BUILD_VERSION=staging-$PAPERCLIP_STAGING_COMMIT" \
  --label "org.opencontainers.image.revision=$PAPERCLIP_STAGING_COMMIT" \
  --tag "$PAPERCLIP_STAGING_IMAGE" "$repo_root"
local_image_id="$(docker image inspect "$PAPERCLIP_STAGING_IMAGE" --format '{{.Id}}')"
local_image_revision="$(docker image inspect "$PAPERCLIP_STAGING_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ -n "$local_image_id" && "$local_image_revision" == "$PAPERCLIP_STAGING_COMMIT" ]] || { echo "locally built image provenance does not match reviewed commit" >&2; exit 2; }
if [[ -n "$prior_image_id" ]]; then
  deployment_phase="prior-stop-attempted"
  timeout 120 docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" stop
  deployment_phase="prior-stopped"
  backup_volume "${PAPERCLIP_STAGING_PROJECT}_db" db.tgz
  backup_volume "${PAPERCLIP_STAGING_PROJECT}_runtime" runtime.tgz
  [[ -s "$backup_dir/db.tgz" && -s "$backup_dir/runtime.tgz" ]] || { echo "rollback archives are missing or empty" >&2; exit 1; }
  tar -tzf "$backup_dir/db.tgz" >/dev/null
  tar -tzf "$backup_dir/runtime.tgz" >/dev/null
  deployment_phase="backups-prepared"
fi
deployment_phase="new-start-attempted"
timeout "$start_timeout" docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" up -d --wait
deployment_phase="new-stack-started"

after_prod="$(snapshot_production)"
require_unchanged_production_identity "$before_prod" "$after_prod"
after_digest="$(docker image inspect "$PAPERCLIP_STAGING_IMAGE" --format '{{.Id}}')"
health="$(curl --connect-timeout 5 --max-time 15 --fail --silent "$PAPERCLIP_STAGING_PUBLIC_URL/api/health" | jq -r .status)"
require_staging_health "$health"

jq -n \
  --arg commit "$PAPERCLIP_STAGING_COMMIT" \
  --arg project "$PAPERCLIP_STAGING_PROJECT" \
  --arg endpoint "$PAPERCLIP_STAGING_PUBLIC_URL" \
  --arg preImageDigest "$before_digest" \
  --arg postImageDigest "$after_digest" \
  --arg health "$health" \
  --arg productionProject "$PAPERCLIP_PRODUCTION_PROJECT" \
  --argjson dataRollbackPrepared "$([[ -n "$prior_image_id" ]] && echo true || echo false)" \
  --arg dbBackupSha256 "$([[ -f "$backup_dir/db.tgz" ]] && sha256sum "$backup_dir/db.tgz" | cut -d' ' -f1 || true)" \
  --arg runtimeBackupSha256 "$([[ -f "$backup_dir/runtime.tgz" ]] && sha256sum "$backup_dir/runtime.tgz" | cut -d' ' -f1 || true)" \
  --arg rollbackAttempt "$(basename "$backup_dir")" \
  --arg productionStateSha256 "$(printf '%s' "$after_prod" | sha256sum | cut -d' ' -f1)" \
  '{commit:$commit,composeProject:$project,privateEndpoint:$endpoint,preImageDigest:$preImageDigest,postImageDigest:$postImageDigest,health:$health,productionProject:$productionProject,productionStateSha256:$productionStateSha256,dataRollbackPrepared:$dataRollbackPrepared,rollbackAttempt:$rollbackAttempt,dbBackupSha256:$dbBackupSha256,runtimeBackupSha256:$runtimeBackupSha256}' \
  >"$receipt"
trap - EXIT
echo "staging deploy receipt: $receipt"
