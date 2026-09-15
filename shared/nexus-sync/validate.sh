#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
SERVICE_SOURCE="$ROOT/nexus-sync.service"
TIMER_SOURCE="$ROOT/nexus-sync.timer"
REMOTE="${OPENCLAW_NEXUS_REMOTE:-}"
BRANCH="main"
PRIMARY_CHECKOUT="/home/dubrovin/.openclaw/workspace/nexus"
TASK_CHECKOUT="/home/dubrovin/.openclaw/workspace-tasks/nexus"
UNIT_DIR="/home/dubrovin/.config/systemd/user"
DISABLED_PUSH_URL="disabled://nexus-read-only"
MISMATCHES=0

fail() {
  echo "$*" >&2
  exit 2
}

mismatch() {
  echo "$*" >&2
  MISMATCHES=$((MISMATCHES + 1))
}

usage() {
  echo "Usage: $0 --source|--runtime" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
case "$1" in
  --source) MODE=source ;;
  --runtime) MODE=runtime ;;
  *) usage ;;
esac

[ -f "$SERVICE_SOURCE" ] || fail "Missing nexus-sync.service"
[ -f "$TIMER_SOURCE" ] || fail "Missing nexus-sync.timer"
bash -n "$ROOT/install.sh"
grep -F 'REMOTE="${OPENCLAW_NEXUS_REMOTE:-}"' "$ROOT/install.sh" >/dev/null \
  || fail "install.sh must receive the private Nexus remote externally"
grep -Fx "DISABLED_PUSH_URL=\"$DISABLED_PUSH_URL\"" "$ROOT/install.sh" >/dev/null \
  || fail "install.sh disabled push contract differs from validator"

grep -Fx 'Type=oneshot' "$SERVICE_SOURCE" >/dev/null
grep -Fx 'ExecStart=/usr/bin/git -C /home/dubrovin/.openclaw/workspace/nexus pull --ff-only' "$SERVICE_SOURCE" >/dev/null
grep -Fx 'ExecStart=/usr/bin/git -C /home/dubrovin/.openclaw/workspace-tasks/nexus pull --ff-only' "$SERVICE_SOURCE" >/dev/null
[ "$(grep -c '^ExecStart=' "$SERVICE_SOURCE")" -eq 2 ] || fail "nexus-sync.service must own exactly two sync commands"
grep -Fx 'OnCalendar=*:0/5' "$TIMER_SOURCE" >/dev/null
grep -Fx 'Persistent=true' "$TIMER_SOURCE" >/dev/null
grep -Fx 'Unit=nexus-sync.service' "$TIMER_SOURCE" >/dev/null
grep -Fx 'WantedBy=timers.target' "$TIMER_SOURCE" >/dev/null

if [ "$MODE" = "source" ]; then
  printf 'NEXUS_SYNC_SOURCE_VALIDATION_PASS\n'
  exit 0
fi

[ -n "$REMOTE" ] || fail "OPENCLAW_NEXUS_REMOTE is required for runtime validation"
case "$REMOTE" in *$'\n'*|*$'\r'*) fail "OPENCLAW_NEXUS_REMOTE must be a single line" ;; esac
[ "$HOME" = "/home/dubrovin" ] || fail "Unexpected HOME: $HOME"
command -v git >/dev/null 2>&1 || fail "git unavailable"
command -v systemctl >/dev/null 2>&1 || fail "systemctl unavailable"
command -v stat >/dev/null 2>&1 || fail "stat unavailable"

validate_unit() {
  local source=$1 target=$2 label=$3 mode
  if [ ! -f "$target" ]; then
    mismatch "Installed $label differs from source"
    return 0
  fi
  cmp -s "$source" "$target" || mismatch "Installed $label differs from source"
  mode=$(stat -c '%a' "$target") || fail "Unable to read installed mode: $target"
  [ "$mode" = "644" ] || mismatch "Installed $label mode is not 0644: $mode"
}

validate_unit "$SERVICE_SOURCE" "$UNIT_DIR/nexus-sync.service" "nexus-sync.service"
validate_unit "$TIMER_SOURCE" "$UNIT_DIR/nexus-sync.timer" "nexus-sync.timer"

validate_checkout() {
  local checkout=$1 fetch push branch status head origin_head
  [ -d "$checkout/.git" ] || fail "Missing Nexus checkout: $checkout"
  fetch=$(git -C "$checkout" remote get-url origin) \
    || fail "Unable to read Nexus fetch remote: $checkout"
  [ "$fetch" = "$REMOTE" ] || mismatch "Unexpected Nexus fetch remote: $checkout"
  push=$(git -C "$checkout" remote get-url --push origin) \
    || fail "Unable to read Nexus push remote: $checkout"
  [ "$push" = "$DISABLED_PUSH_URL" ] || mismatch "Nexus push path is not disabled: $checkout"
  branch=$(git -C "$checkout" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
  [ "$branch" = "$BRANCH" ] || mismatch "Nexus checkout is not on $BRANCH: $checkout"
  status=$(git -C "$checkout" status --porcelain) \
    || fail "Unable to read Nexus checkout status: $checkout"
  [ -z "$status" ] || mismatch "Nexus checkout has local changes: $checkout"
  head=$(git -C "$checkout" rev-parse HEAD) \
    || fail "Unable to read Nexus checkout HEAD: $checkout"
  origin_head=$(git -C "$checkout" rev-parse "origin/$BRANCH") \
    || fail "Unable to read Nexus origin/$BRANCH: $checkout"
  [ "$head" = "$origin_head" ] || mismatch "Nexus checkout is not at its fetched origin/$BRANCH: $checkout"
}

validate_checkout "$PRIMARY_CHECKOUT"
validate_checkout "$TASK_CHECKOUT"

timer_enabled=$(systemctl --user is-enabled nexus-sync.timer 2>/dev/null || true)
[ "$timer_enabled" = "enabled" ] || mismatch "nexus-sync.timer is not enabled"
timer_active=$(systemctl --user is-active nexus-sync.timer 2>/dev/null || true)
[ "$timer_active" = "active" ] || mismatch "nexus-sync.timer is not active"
service_result=$(systemctl --user show nexus-sync.service --property=Result --value) \
  || fail "Unable to read last nexus-sync.service result"
[ "$service_result" = "success" ] || mismatch "Last nexus-sync.service result is not success"

if [ "$MISMATCHES" -ne 0 ]; then
  printf 'NEXUS_SYNC_RUNTIME_VALIDATION_MISMATCHES=%s\n' "$MISMATCHES" >&2
  exit 2
fi

printf 'NEXUS_SYNC_RUNTIME_VALIDATION_PASS\n'
