#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")" && pwd)
SERVICE_SOURCE="$ROOT/nexus-sync.service"
TIMER_SOURCE="$ROOT/nexus-sync.timer"
REMOTE="${OPENCLAW_NEXUS_REMOTE:-}"
BRANCH="main"
PRIMARY_CHECKOUT="/home/dubrovin/.openclaw/workspace/nexus"
TASK_CHECKOUT="/home/dubrovin/.openclaw/workspace-tasks/nexus"
UNIT_DIR="/home/dubrovin/.config/systemd/user"
SERVICE_TARGET="$UNIT_DIR/nexus-sync.service"
TIMER_TARGET="$UNIT_DIR/nexus-sync.timer"
DISABLED_PUSH_URL="disabled://nexus-read-only"

fail() {
  echo "$*" >&2
  exit 2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command unavailable: $1"
}

usage() {
  echo "Usage: OPENCLAW_NEXUS_REMOTE=<private-read-only-remote> $0 --preflight|--apply" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
case "$1" in
  --preflight) MODE=preflight ;;
  --apply) MODE=apply ;;
  *) usage ;;
esac

[ -n "$REMOTE" ] || fail "OPENCLAW_NEXUS_REMOTE is required"
case "$REMOTE" in *$'\n'*|*$'\r'*) fail "OPENCLAW_NEXUS_REMOTE must be a single line" ;; esac
[ "$(id -u)" -ne 0 ] || fail "Run as the OpenClaw owner, not root"
[ "$HOME" = "/home/dubrovin" ] || fail "Unexpected HOME: $HOME"
for cmd in git install systemctl cmp bash; do require_cmd "$cmd"; done
[ -f "$SERVICE_SOURCE" ] || fail "Missing nexus-sync.service"
[ -f "$TIMER_SOURCE" ] || fail "Missing nexus-sync.timer"
bash "$ROOT/validate.sh" --source >/dev/null

GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$REMOTE" "refs/heads/$BRANCH" >/dev/null \
  || fail "Registered Nexus repository is not reachable through the current read-only authentication path"

check_existing_unit() {
  local source=$1 target=$2
  if [ -e "$target" ] && ! cmp -s "$source" "$target"; then
    fail "Installed unit differs from implementation source: $target"
  fi
}

check_checkout() {
  local checkout=$1 push
  if [ ! -e "$checkout" ]; then
    return 0
  fi
  [ -d "$checkout/.git" ] || fail "Existing Nexus path is not a Git checkout: $checkout"
  [ "$(git -C "$checkout" remote get-url origin)" = "$REMOTE" ] \
    || fail "Unexpected Nexus fetch remote: $checkout"
  push=$(git -C "$checkout" remote get-url --push origin)
  [ "$push" = "$DISABLED_PUSH_URL" ] \
    || fail "Existing Nexus checkout does not have the registered disabled push path: $checkout"
  [ "$(git -C "$checkout" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" = "$BRANCH" ] \
    || fail "Nexus checkout is not on $BRANCH: $checkout"
  [ -z "$(git -C "$checkout" status --porcelain)" ] \
    || fail "Nexus checkout has local changes: $checkout"
}

check_existing_unit "$SERVICE_SOURCE" "$SERVICE_TARGET"
check_existing_unit "$TIMER_SOURCE" "$TIMER_TARGET"
check_checkout "$PRIMARY_CHECKOUT"
check_checkout "$TASK_CHECKOUT"

if [ "$MODE" = "preflight" ]; then
  printf 'NEXUS_SYNC_PREFLIGHT_PASS\n'
  exit 0
fi

prepare_checkout() {
  local checkout=$1 parent
  parent=$(dirname "$checkout")
  if [ ! -e "$parent" ]; then
    install -d -m 700 "$parent"
  fi
  [ -d "$parent" ] || fail "Checkout parent is not a directory: $parent"
  if [ ! -e "$checkout" ]; then
    GIT_TERMINAL_PROMPT=0 git clone --quiet --branch "$BRANCH" --single-branch "$REMOTE" "$checkout"
    git -C "$checkout" config remote.origin.pushurl "$DISABLED_PUSH_URL"
  fi
  git -C "$checkout" config pull.ff only
  GIT_TERMINAL_PROMPT=0 git -C "$checkout" pull --ff-only >/dev/null
}

prepare_checkout "$PRIMARY_CHECKOUT"
prepare_checkout "$TASK_CHECKOUT"

if [ ! -e "$UNIT_DIR" ]; then
  install -d -m 700 "$UNIT_DIR"
fi
[ -d "$UNIT_DIR" ] || fail "User systemd unit path is not a directory: $UNIT_DIR"
install -m 644 "$SERVICE_SOURCE" "$SERVICE_TARGET"
install -m 644 "$TIMER_SOURCE" "$TIMER_TARGET"
systemctl --user daemon-reload
systemctl --user enable --now nexus-sync.timer >/dev/null
systemctl --user start nexus-sync.service

bash "$ROOT/validate.sh" --runtime
printf 'NEXUS_SYNC_APPLY_PASS\n'
