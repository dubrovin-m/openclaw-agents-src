#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="$HOME/.npm-global/bin${PATH:+:$PATH}"

STATE_DIR="${OPC_STATE_DIR:-$HOME/.local/state/openclaw-production-control}"
LIB_DIR="${OPC_LIB_DIR:-$HOME/.local/lib/openclaw-production-control}"
CONTROLLER="${OPC_CONTROLLER:-$LIB_DIR/controller.mjs}"
REVISION_FILE="${OPC_INSTALLED_REVISION_FILE:-$LIB_DIR/installed-revision}"
STATE_FILE="$STATE_DIR/state.json"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# Kernel advisory lock prevents concurrent poller wrappers. The controller.lock
# is the cross-ingress mutation lock shared with semantic operations. Never remove
# a lock owned by a live process; only recover a stale lock after its owner exited.
exec 9>"$STATE_DIR/poll.lock"
if ! flock -n 9; then
  exit 0
fi
CONTROLLER_LOCK="$STATE_DIR/controller.lock"
if [ -e "$CONTROLLER_LOCK" ]; then
  read -r LOCK_PID _ < "$CONTROLLER_LOCK" || { echo "Controller lock evidence unreadable" >&2; exit 2; }
  [[ "$LOCK_PID" =~ ^[1-9][0-9]*$ ]] || { echo "Controller lock evidence invalid" >&2; exit 2; }
  if kill -0 "$LOCK_PID" 2>/dev/null; then
    exit 0
  fi
  rm -f "$CONTROLLER_LOCK"
fi

# The runtime must never process requests under a controller revision different
# from the revision recorded at bootstrap. This makes installed-source provenance
# an effective runtime gate rather than documentation only.
[ -f "$STATE_FILE" ] || { echo "Controller state is not initialized" >&2; exit 2; }
[ -f "$REVISION_FILE" ] || { echo "Installed controller revision evidence missing" >&2; exit 2; }
INSTALLED_REVISION=$(tr -d '\r\n' < "$REVISION_FILE")
EXPECTED_REVISION=$(node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(s.controller_revision||""));' "$STATE_FILE")
[[ "$INSTALLED_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "Installed controller revision evidence invalid" >&2; exit 2; }
[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "Controller state revision evidence invalid" >&2; exit 2; }
[ "$INSTALLED_REVISION" = "$EXPECTED_REVISION" ] || { echo "Installed controller revision does not match bootstrapped revision" >&2; exit 2; }

exec "$CONTROLLER" poll
