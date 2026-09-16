#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)
TEST_ROOT=""
APPLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --test-root)
      [ "$#" -ge 2 ] || { echo "--test-root requires a path" >&2; exit 2; }
      TEST_ROOT=$2; shift 2 ;;
    *) echo "Usage: $0 [--test-root /absolute/path] --apply" >&2; exit 2 ;;
  esac
done

[ "$APPLY" -eq 1 ] || { echo "--apply is required" >&2; exit 2; }
for cmd in install mkdir realpath node flock git; do command -v "$cmd" >/dev/null 2>&1 || { echo "Required command unavailable: $cmd" >&2; exit 2; }; done

REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null) || { echo "Installer must run from the authoritative git checkout" >&2; exit 2; }
SOURCE_REVISION=$(git -C "$REPO_ROOT" rev-parse HEAD)
[[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "Cannot establish exact source revision" >&2; exit 2; }
[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ] || { echo "Refusing installation from a dirty source checkout" >&2; exit 2; }
RUNTIME_CONTRACT="$REPO_ROOT/runtime-contract.json"
RUNTIME_HELPER="$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs"
[ -f "$RUNTIME_CONTRACT" ] && [ -f "$RUNTIME_HELPER" ] || { echo "Runtime contract source unavailable" >&2; exit 2; }
node "$RUNTIME_HELPER" repo-check "$REPO_ROOT" >/dev/null || { echo "Runtime contract validation failed" >&2; exit 2; }

if [ -n "$TEST_ROOT" ]; then
  case "$TEST_ROOT" in /*) ;; *) echo "--test-root must be absolute" >&2; exit 2;; esac
  mkdir -p "$TEST_ROOT"
  TEST_ROOT=$(realpath -e "$TEST_ROOT")
  case "$TEST_ROOT" in /|/home/dubrovin|/home/dubrovin/*) echo "Refusing unsafe test root: $TEST_ROOT" >&2; exit 2;; esac
  HOME_DIR="$TEST_ROOT/home"
else
  HOME_DIR="/home/dubrovin"
fi

LIB_DIR="$HOME_DIR/.local/lib/openclaw-production-control"
STATE_DIR="$HOME_DIR/.local/state/openclaw-production-control"
SOURCE_DIR="$HOME_DIR/.local/share/openclaw-production-control/openclaw-agents"
CONFIG_DIR="$HOME_DIR/.config/openclaw-production-control"
SYSTEMD_DIR="$HOME_DIR/.config/systemd/user"

mkdir -p "$LIB_DIR" "$STATE_DIR" "$SOURCE_DIR" "$CONFIG_DIR" "$SYSTEMD_DIR"
chmod 700 "$LIB_DIR" "$STATE_DIR" "$SOURCE_DIR" "$CONFIG_DIR"

install -m 700 "$ROOT/controller.mjs" "$LIB_DIR/controller.mjs"
install -m 600 "$ROOT/lib.mjs" "$LIB_DIR/lib.mjs"
install -m 700 "$ROOT/diagnose.mjs" "$LIB_DIR/diagnose.mjs"
install -m 600 "$RUNTIME_HELPER" "$LIB_DIR/runtime-contract.mjs"
install -m 600 "$RUNTIME_CONTRACT" "$LIB_DIR/runtime-contract.json"
install -m 700 "$ROOT/execute-deploy.sh" "$LIB_DIR/execute-deploy.sh"
install -m 700 "$ROOT/execute-rollout.sh" "$LIB_DIR/execute-rollout.sh"
install -m 700 "$ROOT/poll.sh" "$LIB_DIR/poll.sh"
install -m 700 "$ROOT/bootstrap.sh" "$LIB_DIR/bootstrap.sh"
printf '%s\n' "$SOURCE_REVISION" > "$LIB_DIR/installed-revision"
chmod 600 "$LIB_DIR/installed-revision"
install -m 644 "$ROOT/openclaw-task-production-control.service" "$SYSTEMD_DIR/openclaw-task-production-control.service"
install -m 644 "$ROOT/openclaw-task-production-control.timer" "$SYSTEMD_DIR/openclaw-task-production-control.timer"

node --check "$LIB_DIR/controller.mjs"
node --check "$LIB_DIR/diagnose.mjs"
node --check "$LIB_DIR/lib.mjs"
node --check "$LIB_DIR/runtime-contract.mjs"
node "$LIB_DIR/runtime-contract.mjs" validate "$LIB_DIR/runtime-contract.json" >/dev/null
bash -n "$LIB_DIR/execute-rollout.sh"
bash -n "$LIB_DIR/poll.sh"
bash -n "$LIB_DIR/bootstrap.sh"

if [ -z "$TEST_ROOT" ]; then
  command -v systemctl >/dev/null 2>&1 || { echo "Required command unavailable: systemctl" >&2; exit 2; }
  systemctl --user daemon-reload
fi

cat <<EOF
PRODUCTION_CONTROL_INSTALL_PASS
lib=$LIB_DIR
state=$STATE_DIR
source=$SOURCE_DIR
token=$CONFIG_DIR/github-token
installed_revision=$SOURCE_REVISION
mode=STAGED_NOT_ENABLED
EOF
