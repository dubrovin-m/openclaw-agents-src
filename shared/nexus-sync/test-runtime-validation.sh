#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PACKAGE="$TMP/nexus-sync"
PRIMARY="$TMP/runtime/workspace/nexus"
TASK="$TMP/runtime/workspace-tasks/nexus"
UNIT_DIR="$TMP/runtime/systemd"
MOCK_BIN="$TMP/bin"
TEST_REMOTE='ssh://git@example.invalid/private/nexus.git'

mkdir -p "$PACKAGE" "$PRIMARY/.git" "$TASK/.git" "$UNIT_DIR" "$MOCK_BIN"
cp -R "$ROOT/." "$PACKAGE/"
cp "$ROOT/nexus-sync.service" "$UNIT_DIR/nexus-sync.service"
cp "$ROOT/nexus-sync.timer" "$UNIT_DIR/nexus-sync.timer"
printf '\n# synthetic content drift\n' >> "$UNIT_DIR/nexus-sync.timer"
chmod 664 "$UNIT_DIR/nexus-sync.timer"

sed -i "s|^PRIMARY_CHECKOUT=.*|PRIMARY_CHECKOUT=\"$PRIMARY\"|" "$PACKAGE/validate.sh"
sed -i "s|^TASK_CHECKOUT=.*|TASK_CHECKOUT=\"$TASK\"|" "$PACKAGE/validate.sh"
sed -i "s|^UNIT_DIR=.*|UNIT_DIR=\"$UNIT_DIR\"|" "$PACKAGE/validate.sh"

cat > "$MOCK_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[ "${1:-}" = "-C" ] || exit 90
checkout=$2
shift 2

if [ "${1:-}" = "remote" ] && [ "${2:-}" = "get-url" ]; then
  if [ "${3:-}" = "origin" ]; then
    printf '%s\n' "$TEST_REMOTE"
    exit 0
  fi
  if [ "${3:-}" = "--push" ] && [ "${4:-}" = "origin" ]; then
    case "$checkout" in
      "$TEST_PRIMARY"|"$TEST_TASK") printf '%s\n' 'DISABLED' ;;
      *) exit 91 ;;
    esac
    exit 0
  fi
fi

if [ "${1:-}" = "symbolic-ref" ]; then
  printf '%s\n' 'main'
  exit 0
fi

if [ "${1:-}" = "status" ] && [ "${2:-}" = "--porcelain" ]; then
  exit 0
fi

if [ "${1:-}" = "rev-parse" ]; then
  printf '%s\n' 'deadbeef'
  exit 0
fi

exit 92
EOF
chmod +x "$MOCK_BIN/git"

cat > "$MOCK_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  '--user is-enabled nexus-sync.timer')
    if [ "${TEST_SYSTEMD_DRIFT:-0}" = "1" ]; then
      printf '%s\n' 'disabled'
      exit 1
    fi
    printf '%s\n' 'enabled'
    ;;
  '--user is-active nexus-sync.timer')
    if [ "${TEST_SYSTEMD_DRIFT:-0}" = "1" ]; then
      printf '%s\n' 'inactive'
      exit 3
    fi
    printf '%s\n' 'active'
    ;;
  '--user show nexus-sync.service --property=Result --value') printf '%s\n' 'success' ;;
  *) exit 93 ;;
esac
EOF
chmod +x "$MOCK_BIN/systemctl"

run_runtime() {
  local home=$1 systemd_drift=$2 output rc
  set +e
  output=$(PATH="$MOCK_BIN:$PATH" HOME="$home" TEST_PRIMARY="$PRIMARY" TEST_TASK="$TASK" TEST_REMOTE="$TEST_REMOTE" \
    OPENCLAW_NEXUS_REMOTE="$TEST_REMOTE" TEST_SYSTEMD_DRIFT="$systemd_drift" bash "$PACKAGE/validate.sh" --runtime 2>&1)
  rc=$?
  set -e
  printf '%s\n' "$rc"
  printf '%s\n' "$output"
}

source_output=$(bash "$ROOT/validate.sh" --source)
[ "$source_output" = 'NEXUS_SYNC_SOURCE_VALIDATION_PASS' ]

runtime_result=$(run_runtime /home/dubrovin 1)
runtime_rc=$(printf '%s\n' "$runtime_result" | head -n1)
runtime_output=$(printf '%s\n' "$runtime_result" | tail -n +2)
[ "$runtime_rc" -eq 2 ]
printf '%s\n' "$runtime_output" | grep -F 'Installed nexus-sync.timer differs from source' >/dev/null
printf '%s\n' "$runtime_output" | grep -F 'Installed nexus-sync.timer mode is not 0644: 664' >/dev/null
[ "$(printf '%s\n' "$runtime_output" | grep -Fc 'Nexus push path is not disabled:')" -eq 2 ]
printf '%s\n' "$runtime_output" | grep -F 'nexus-sync.timer is not enabled' >/dev/null
printf '%s\n' "$runtime_output" | grep -F 'nexus-sync.timer is not active' >/dev/null
printf '%s\n' "$runtime_output" | grep -F 'NEXUS_SYNC_RUNTIME_VALIDATION_MISMATCHES=6' >/dev/null
if printf '%s\n' "$runtime_output" | grep -F 'NEXUS_SYNC_RUNTIME_VALIDATION_PASS' >/dev/null; then
  echo 'Runtime PASS must not be emitted when mismatches exist' >&2
  exit 1
fi

prereq_result=$(run_runtime /unexpected-home 0)
prereq_rc=$(printf '%s\n' "$prereq_result" | head -n1)
prereq_output=$(printf '%s\n' "$prereq_result" | tail -n +2)
[ "$prereq_rc" -eq 2 ]
printf '%s\n' "$prereq_output" | grep -F 'Unexpected HOME: /unexpected-home' >/dev/null
if printf '%s\n' "$prereq_output" | grep -E 'Installed nexus-sync|Nexus push path|nexus-sync.timer is not|NEXUS_SYNC_RUNTIME_VALIDATION_MISMATCHES' >/dev/null; then
  echo 'Prerequisite failure must stop before independent runtime checks' >&2
  exit 1
fi

printf 'NEXUS_SYNC_RUNTIME_REGRESSION_PASS\n'
