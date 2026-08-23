#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/lib/staging-paperclip-guard.sh"

: "${PAPERCLIP_STAGING_PROJECT:?set PAPERCLIP_STAGING_PROJECT}"
: "${PAPERCLIP_STAGING_PUBLIC_URL:?set PAPERCLIP_STAGING_PUBLIC_URL}"
: "${PAPERCLIP_STAGING_ADMIN_PASSWORD:?inject PAPERCLIP_STAGING_ADMIN_PASSWORD at runtime}"
: "${PAPERCLIP_PRODUCTION_PROJECT:?set PAPERCLIP_PRODUCTION_PROJECT}"
: "${PAPERCLIP_STAGING_SECRET_DIR:?set PAPERCLIP_STAGING_SECRET_DIR}"
: "${PAPERCLIP_STAGING_PORT:=3310}"

require_staging_preflight

admin_name="${PAPERCLIP_STAGING_ADMIN_NAME:-OCC Staging Admin}"
admin_email="${PAPERCLIP_STAGING_ADMIN_EMAIL:-paperclip-staging@oxfordcigar.invalid}"
compose_file="${PAPERCLIP_STAGING_COMPOSE_FILE:-docker/staging/compose.yml}"
scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-staging-bootstrap.XXXXXX")"
cookie_jar="$scratch_dir/cookies"
trap 'rm -rf "$scratch_dir"' EXIT

post_json() {
  local path="$1"
  local json="$2"
  local output="$3"
  curl --silent --show-error --output "$output" --write-out '%{http_code}' \
    --cookie "$cookie_jar" --cookie-jar "$cookie_jar" \
    --header 'Content-Type: application/json' \
    --header "Origin: $PAPERCLIP_STAGING_PUBLIC_URL" \
    --request POST "$PAPERCLIP_STAGING_PUBLIC_URL$path" --data "$json"
}

signup_json="$(jq -cn --arg name "$admin_name" --arg email "$admin_email" --arg password "$PAPERCLIP_STAGING_ADMIN_PASSWORD" '{name:$name,email:$email,password:$password}')"
status="$(post_json /api/auth/sign-up/email "$signup_json" "$scratch_dir/signup.json")"
if [[ ! "$status" =~ ^2 ]]; then
  signin_json="$(jq -cn --arg email "$admin_email" --arg password "$PAPERCLIP_STAGING_ADMIN_PASSWORD" '{email:$email,password:$password}')"
  status="$(post_json /api/auth/sign-in/email "$signin_json" "$scratch_dir/signin.json")"
  [[ "$status" =~ ^2 ]] || { echo "staging bootstrap: sign-up/sign-in failed (HTTP $status)" >&2; exit 1; }
fi

health_json="$(curl --fail --silent "$PAPERCLIP_STAGING_PUBLIC_URL/api/health")"
if [[ "$health_json" != *'"bootstrapStatus":"ready"'* ]]; then
  invite_output="$(docker compose -p "$PAPERCLIP_STAGING_PROJECT" -f "$compose_file" exec -T server \
    pnpm paperclipai auth bootstrap-ceo --data-dir /paperclip-staging --base-url "$PAPERCLIP_STAGING_PUBLIC_URL")"
  invite_token="$(printf '%s\n' "$invite_output" | sed -n 's#.*\/invite\/\(pcp_bootstrap_[[:alnum:]]*\).*#\1#p' | tail -1)"
  [[ -n "$invite_token" ]] || { echo "staging bootstrap: CLI returned no bootstrap token" >&2; exit 1; }
  status="$(post_json "/api/invites/$invite_token/accept" '{"requestType":"human"}' "$scratch_dir/accept.json")"
  [[ "$status" =~ ^2 ]] || { echo "staging bootstrap: invite acceptance failed (HTTP $status)" >&2; exit 1; }
fi

session_json="$(curl --fail --silent --cookie "$cookie_jar" --cookie-jar "$cookie_jar" "$PAPERCLIP_STAGING_PUBLIC_URL/api/auth/get-session")"
companies_json="$(curl --fail --silent --cookie "$cookie_jar" --cookie-jar "$cookie_jar" "$PAPERCLIP_STAGING_PUBLIC_URL/api/companies")"
jq -e '.user.id // .session.userId' >/dev/null <<<"$session_json"
jq -e 'type == "array"' >/dev/null <<<"$companies_json"
echo "staging bootstrap: authenticated UI/API smoke ready for $admin_email"
