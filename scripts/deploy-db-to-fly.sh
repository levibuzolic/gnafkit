#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <sqlite-path>" >&2
  exit 1
fi

sqlite_path="$1"

: "${FLY_API_TOKEN:?FLY_API_TOKEN is required}"
: "${FLY_APP_NAME:?FLY_APP_NAME is required}"

ssh_token="${FLY_SSH_TOKEN:-$FLY_API_TOKEN}"
flyctl_base=(fly --access-token "$ssh_token")

machine_json="$(
  curl -fsSL \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "https://api.machines.dev/v1/apps/${FLY_APP_NAME}/machines"
)"

machine_id="$(
  printf '%s' "$machine_json" | bun -e '
    const machines = JSON.parse(await Bun.stdin.text());
    const machine = machines.find((entry) => entry.state !== "destroyed");
    if (!machine?.id) {
      console.error("No active Fly machine found for app.");
      process.exit(1);
    }
    process.stdout.write(machine.id);
  '
)"

machine_state="$(
  printf '%s' "$machine_json" | bun -e '
    const machines = JSON.parse(await Bun.stdin.text());
    const machine = machines.find((entry) => entry.state !== "destroyed");
    process.stdout.write(String(machine?.state ?? ""));
  '
)"

if [[ "$machine_state" != "started" ]]; then
  curl -fsSL -X POST \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "https://api.machines.dev/v1/apps/${FLY_APP_NAME}/machines/${machine_id}/start" >/dev/null

  curl -fsSL \
    -H "Authorization: Bearer ${FLY_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "https://api.machines.dev/v1/apps/${FLY_APP_NAME}/machines/${machine_id}/wait?state=started&timeout=300" >/dev/null
fi

"${flyctl_base[@]}" ssh console \
  --app "$FLY_APP_NAME" \
  --machine "$machine_id" \
  -C "/busybox mkdir -p /data/incoming"

"${flyctl_base[@]}" ssh sftp put \
  "$sqlite_path" \
  /data/incoming/gnaf.sqlite.next \
  --app "$FLY_APP_NAME" \
  --machine "$machine_id"

"${flyctl_base[@]}" ssh console \
  --app "$FLY_APP_NAME" \
  --machine "$machine_id" \
  -C "/busybox sh -lc 'set -eu; /busybox rm -f /data/gnaf.sqlite.prev; if [ -f /data/gnaf.sqlite ]; then /busybox mv /data/gnaf.sqlite /data/gnaf.sqlite.prev; fi; /busybox mv /data/incoming/gnaf.sqlite.next /data/gnaf.sqlite'"

curl -fsSL -X POST \
  -H "Authorization: Bearer ${FLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.machines.dev/v1/apps/${FLY_APP_NAME}/machines/${machine_id}/stop" >/dev/null

curl -fsSL \
  -H "Authorization: Bearer ${FLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.machines.dev/v1/apps/${FLY_APP_NAME}/machines/${machine_id}/wait?state=stopped&timeout=300" >/dev/null

curl -fsSL -X POST \
  -H "Authorization: Bearer ${FLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.machines.dev/v1/apps/${FLY_APP_NAME}/machines/${machine_id}/start" >/dev/null

curl -fsSL \
  -H "Authorization: Bearer ${FLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.machines.dev/v1/apps/${FLY_APP_NAME}/machines/${machine_id}/wait?state=started&timeout=300" >/dev/null

if [[ -n "${APP_BASE_URL:-}" ]]; then
  header_args=()
  if [[ -n "${GNAFKIT_API_KEY:-}" ]]; then
    api_key_header="${GNAFKIT_API_KEY_HEADER:-x-api-key}"
    header_args+=(-H "${api_key_header}: ${GNAFKIT_API_KEY}")
  fi

  curl -fsSL "${header_args[@]}" "${APP_BASE_URL%/}/health" >/dev/null
fi
