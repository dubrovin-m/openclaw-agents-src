#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
EXPECTED_REVISION=$(git -C "$ROOT" rev-parse HEAD)

bash "$ROOT/install.sh" --test-root "$TMP" --apply > "$TMP/install.out"
grep -q '^PRODUCTION_CONTROL_INSTALL_PASS$' "$TMP/install.out"
grep -q '^mode=STAGED_NOT_ENABLED$' "$TMP/install.out"
grep -q "^installed_revision=$EXPECTED_REVISION$" "$TMP/install.out"
grep -q "^source=$TMP/home/.local/share/openclaw-production-control/openclaw-agents$" "$TMP/install.out"

LIB="$TMP/home/.local/lib/openclaw-production-control"
SOURCE="$TMP/home/.local/share/openclaw-production-control/openclaw-agents"
SYSTEMD="$TMP/home/.config/systemd/user"
[ -x "$LIB/controller.mjs" ]
[ -x "$LIB/diagnose.mjs" ]
[ -x "$LIB/execute-deploy.sh" ]
[ -x "$LIB/poll.sh" ]
[ -x "$LIB/bootstrap.sh" ]
[ -f "$LIB/runtime-contract.mjs" ]
[ -f "$LIB/runtime-contract.json" ]
[ -d "$SOURCE" ]
[ "$(stat -c %a "$SOURCE")" = 700 ]
[ "$(stat -c %a "$LIB/controller.mjs")" = 700 ]
[ "$(stat -c %a "$LIB/diagnose.mjs")" = 700 ]
[ "$(stat -c %a "$LIB/execute-deploy.sh")" = 700 ]
[ "$(stat -c %a "$LIB/poll.sh")" = 700 ]
[ "$(stat -c %a "$LIB/bootstrap.sh")" = 700 ]
[ "$(stat -c %a "$LIB/lib.mjs")" = 600 ]
[ "$(stat -c %a "$LIB/runtime-contract.mjs")" = 600 ]
[ "$(stat -c %a "$LIB/runtime-contract.json")" = 600 ]
[ "$(stat -c %a "$LIB/installed-revision")" = 600 ]
[ "$(cat "$LIB/installed-revision")" = "$EXPECTED_REVISION" ]
[ -f "$SYSTEMD/openclaw-task-production-control.service" ]
[ -f "$SYSTEMD/openclaw-task-production-control.timer" ]
grep -q 'poll.sh' "$SYSTEMD/openclaw-task-production-control.service"
[ ! -e "$TMP/home/.config/openclaw-production-control/github-token" ]
[ ! -e "$TMP/home/.local/state/openclaw-production-control/state.json" ]

node --check "$LIB/controller.mjs"
node --check "$LIB/diagnose.mjs"
node --check "$LIB/lib.mjs"
node --check "$LIB/runtime-contract.mjs"
node "$LIB/runtime-contract.mjs" validate "$LIB/runtime-contract.json" >/dev/null
bash -n "$LIB/poll.sh"
bash -n "$LIB/bootstrap.sh"

# The production controller runs under a systemd user service rather than an
# interactive shell. Prove that the installed poll wrapper establishes the
# registered per-user npm bin path before it invokes controller diagnostics.
POLL_STATE="$TMP/poll-state"
NPM_BIN="$TMP/home/.npm-global/bin"
mkdir -p "$POLL_STATE" "$NPM_BIN"
chmod 700 "$POLL_STATE" "$NPM_BIN"
cat > "$POLL_STATE/state.json" <<JSON
{"controller_revision":"$EXPECTED_REVISION"}
JSON
chmod 600 "$POLL_STATE/state.json"
ln -s "$(command -v node)" "$NPM_BIN/node"
cat > "$NPM_BIN/openclaw" <<'SH'
#!/bin/sh
set -eu
[ "${1:-}" = "--version" ] || exit 2
printf 'OpenClaw 2026.8.1\n'
SH
chmod 700 "$NPM_BIN/openclaw"
FAKE_CONTROLLER="$TMP/fake-controller.sh"
cat > "$FAKE_CONTROLLER" <<'SH'
#!/bin/sh
set -eu
[ "${1:-}" = "poll" ] || exit 2
[ "$(command -v openclaw)" = "$HOME/.npm-global/bin/openclaw" ] || exit 3
[ "$(openclaw --version)" = "OpenClaw 2026.8.1" ] || exit 4
SH
chmod 700 "$FAKE_CONTROLLER"
HOME="$TMP/home" \
PATH="/usr/bin:/bin" \
OPC_STATE_DIR="$POLL_STATE" \
OPC_CONTROLLER="$FAKE_CONTROLLER" \
OPC_INSTALLED_REVISION_FILE="$LIB/installed-revision" \
  "$LIB/poll.sh"

echo ISOLATED_INSTALL_PASS
