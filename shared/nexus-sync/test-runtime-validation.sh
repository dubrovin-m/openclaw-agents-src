#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PACKAGE="$TMP/nexus-sync"
PRIMARY="$TMP/runtime/workspace/nexus"
TASK="$TMP/runtime/workspace-tasks/nexus"
INVESTMENTS="$TMP/runtime/workspace-investments/nexus"
ENGINEER="$TMP/runtime/workspace-engineer/nexus"
UNIT_DIR="$TMP/runtime/systemd"
MOCK_BIN="$TMP/bin"
TEST_REMOTE='ssh://git@example.invalid/private/nexus.git'

mkdir -p "$PACKAGE" "$PRIMARY/.git" "$TASK/.git" "$INVESTMENTS/.git" "$ENGINEER/.git" "$UNIT_DIR" "$MOCK_BIN"
cp -R "$ROOT/." "$PACKAGE/"
cp "$ROOT/nexus-sync.service" "$UNIT_DIR/nexus-sync.service"
cp "$ROOT/nexus-sync.timer" "$UNIT_DIR/nexus-sync.timer"
printf '\n# synthetic content drift\n' >> "$UNIT_DIR/nexus-sync.timer"
chmod 664 "$UNIT_DIR/nexus-sync.timer"

sed -i "s|^PRIMARY_CHECKOUT=.*|PRIMARY_CHECKOUT=\"$PRIMARY\"|" "$PACKAGE/validate.sh"
sed -i "s|^TASK_CHECKOUT=.*|TASK_CHECKOUT=\"$TASK\"|" "$PACKAGE/validate.sh"
sed -i "s|^INVESTMENTS_CHECKOUT=.*|INVESTMENTS_CHECKOUT=\"$INVESTMENTS\"|" "$PACKAGE/validate.sh"
sed -i "s|^ENGINEER_CHECKOUT=.*|ENGINEER_CHECKOUT=\"$ENGINEER\"|" "$PACKAGE/validate.sh"
for key in PRIMARY TASK INVESTMENTS ENGINEER; do
  checkout="${!key}"
  sed -i "s|^${key}_CHECKOUT=.*|${key}_CHECKOUT=\"$checkout\"|" "$PACKAGE/install.sh"
done
sed -i "s|^UNIT_DIR=.*|UNIT_DIR=\"$UNIT_DIR\"|" "$PACKAGE/install.sh"
sed -i "s|^UNIT_DIR=.*|UNIT_DIR=\"$UNIT_DIR\"|" "$PACKAGE/validate.sh"

cat > "$MOCK_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "hash-object" ]; then
  /usr/bin/git "$@"
  exit 0
fi
if [ "${1:-}" = "ls-remote" ]; then
  exit 0
fi
[ "${1:-}" = "-C" ] || exit 90
checkout=$2
shift 2

if [ "${1:-}" = "remote" ] && [ "${2:-}" = "get-url" ]; then
  if [ "${3:-}" = "origin" ]; then
    if [ "$checkout" = "$TEST_ENGINEER" ] && [ "${TEST_SCENARIO:-}" = engineer_remote ]; then
      printf '%s\n' 'ssh://git@example.invalid/unregistered.git'
      exit 0
    fi
    printf '%s\n' "$TEST_REMOTE"
    exit 0
  fi
  if [ "${3:-}" = "--push" ] && [ "${4:-}" = "origin" ]; then
    case "$checkout" in
      "$TEST_PRIMARY"|"$TEST_TASK"|"$TEST_INVESTMENTS"|"$TEST_ENGINEER")
        if [ "${TEST_SCENARIO:-baseline}" = baseline ]; then
          printf '%s\n' 'DISABLED'
        elif [ "$checkout" = "$TEST_ENGINEER" ] && [ "${TEST_SCENARIO:-}" = engineer_push ]; then
          printf '%s\n' 'ssh://git@example.invalid/write.git'
        else
          printf '%s\n' 'disabled://nexus-read-only'
        fi ;;
      *) exit 91 ;;
    esac
    exit 0
  fi
fi

if [ "${1:-}" = "symbolic-ref" ]; then
  if [ "$checkout" = "$TEST_ENGINEER" ] && [ "${TEST_SCENARIO:-}" = engineer_branch ]; then
    printf '%s\n' 'wrong-branch'
    exit 0
  fi
  printf '%s\n' 'main'
  exit 0
fi

if [ "${1:-}" = "status" ] && [ "${2:-}" = "--porcelain" ]; then
  if [ "$checkout" = "$TEST_ENGINEER" ] && [ "${TEST_SCENARIO:-}" = engineer_dirty ]; then
    printf '%s\n' ' M modified'
  fi
  exit 0
fi

if [ "${1:-}" = "rev-parse" ]; then
  if [ "$checkout" = "$TEST_ENGINEER" ] && [ "${TEST_SCENARIO:-}" = engineer_head ] && [ "${2:-}" = HEAD ]; then
    printf '%s\n' 'stale'
  else
    printf '%s\n' 'deadbeef'
  fi
  exit 0
fi

if [ "${1:-}" = config ]; then
  exit 0
fi
if [ "${1:-}" = pull ]; then
  if [ "$checkout" = "$TEST_ENGINEER" ] && [ "${TEST_SCENARIO:-}" = engineer_pull_failure ]; then
    exit 17
  fi
  printf '%s\n' "$checkout" >> "$TEST_MUTATION_LOG"
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
  '--user daemon-reload'|'--user enable --now nexus-sync.timer'|'--user start nexus-sync.service') : ;;
  *) exit 93 ;;
esac
EOF
chmod +x "$MOCK_BIN/systemctl"

run_runtime() {
  local home=$1 systemd_drift=$2 scenario=${3:-baseline} output rc
  set +e
  output=$(PATH="$MOCK_BIN:$PATH" HOME="$home" TEST_PRIMARY="$PRIMARY" TEST_TASK="$TASK" TEST_INVESTMENTS="$INVESTMENTS" TEST_ENGINEER="$ENGINEER" TEST_REMOTE="$TEST_REMOTE" \
    TEST_SCENARIO="$scenario" TEST_MUTATION_LOG="$TMP/mutations" OPENCLAW_NEXUS_REMOTE="$TEST_REMOTE" TEST_SYSTEMD_DRIFT="$systemd_drift" bash "$PACKAGE/validate.sh" --runtime 2>&1)
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
[ "$(printf '%s\n' "$runtime_output" | grep -Fc 'Nexus push path is not disabled:')" -eq 4 ]
printf '%s\n' "$runtime_output" | grep -F 'nexus-sync.timer is not enabled' >/dev/null
printf '%s\n' "$runtime_output" | grep -F 'nexus-sync.timer is not active' >/dev/null
printf '%s\n' "$runtime_output" | grep -F 'NEXUS_SYNC_RUNTIME_VALIDATION_MISMATCHES=8' >/dev/null
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

# A healthy four-mirror state must succeed.
cp "$ROOT/nexus-sync.timer" "$UNIT_DIR/nexus-sync.timer"
chmod 644 "$UNIT_DIR/nexus-sync.timer"
healthy=$(run_runtime /home/dubrovin 0 healthy)
[ "$(printf '%s\n' "$healthy" | head -n1)" -eq 0 ]
printf '%s\n' "$healthy" | grep -Fx 'NEXUS_SYNC_RUNTIME_VALIDATION_PASS' >/dev/null

# Source contract must reject removal of Engineer even when three mirrors still match.
cp "$PACKAGE/nexus-sync.service" "$TMP/four.service"
sed -i '/^ExecStart=.*workspace-engineer\/nexus pull --ff-only$/d' "$PACKAGE/nexus-sync.service"
if bash "$PACKAGE/validate.sh" --source >/dev/null 2>&1; then
  echo 'Source validation accepted three mirrors' >&2; exit 1
fi
cp "$TMP/four.service" "$PACKAGE/nexus-sync.service"

# Every Engineer integrity condition is enforced independently.
for item in remote push branch dirty head; do
  result=$(run_runtime /home/dubrovin 0 "engineer_$item")
  [ "$(printf '%s\n' "$result" | head -n1)" -eq 2 ]
  printf '%s\n' "$result" | grep -F "$ENGINEER" >/dev/null
  if printf '%s\n' "$result" | grep -F 'NEXUS_SYNC_RUNTIME_VALIDATION_PASS' >/dev/null; then
    echo "Invalid Engineer $item returned PASS" >&2; exit 1
  fi
done
mv "$ENGINEER/.git" "$ENGINEER/missing-git"
result=$(run_runtime /home/dubrovin 0 healthy)
[ "$(printf '%s\n' "$result" | head -n1)" -eq 2 ]
printf '%s\n' "$result" | grep -F "Missing Nexus checkout: $ENGINEER" >/dev/null
mv "$ENGINEER/missing-git" "$ENGINEER/.git"

run_installer() {
  local mode=$1 scenario=${2:-healthy} output rc
  set +e
  output=$(PATH="$MOCK_BIN:$PATH" HOME=/home/dubrovin TEST_PRIMARY="$PRIMARY" TEST_TASK="$TASK" TEST_INVESTMENTS="$INVESTMENTS" TEST_ENGINEER="$ENGINEER" \
    TEST_REMOTE="$TEST_REMOTE" TEST_SCENARIO="$scenario" TEST_MUTATION_LOG="$TMP/mutations" \
    OPENCLAW_NEXUS_REMOTE="$TEST_REMOTE" bash "$PACKAGE/install.sh" "$mode" 2>&1)
  rc=$?
  set -e
  printf '%s\n%s\n' "$rc" "$output"
}

# Preflight checks Engineer; an unsafe push boundary fails before mutation.
result=$(run_installer --preflight engineer_push)
[ "$(printf '%s\n' "$result" | head -n1)" -eq 2 ]
printf '%s\n' "$result" | grep -F "Existing Nexus checkout does not have the registered disabled push path: $ENGINEER" >/dev/null

# Frozen predecessor is accepted only by explicit transition modes.
cp "$PACKAGE/nexus-sync.service.three-mirror" "$UNIT_DIR/nexus-sync.service"
result=$(run_installer --preflight)
[ "$(printf '%s\n' "$result" | head -n1)" -eq 2 ]
result=$(run_installer --preflight-from-three)
[ "$(printf '%s\n' "$result" | head -n1)" -eq 0 ]
printf '%s\n' "$result" | grep -Fx 'NEXUS_SYNC_PREFLIGHT_PASS' >/dev/null
printf '\n# unapproved drift\n' >> "$UNIT_DIR/nexus-sync.service"
result=$(run_installer --preflight-from-three)
[ "$(printf '%s\n' "$result" | head -n1)" -eq 2 ]
cp "$PACKAGE/nexus-sync.service.three-mirror" "$UNIT_DIR/nexus-sync.service"

# A failed fourth pull must not install the new service or return overall success.
result=$(run_installer --apply-from-three engineer_pull_failure)
[ "$(printf '%s\n' "$result" | head -n1)" -ne 0 ]
if printf '%s\n' "$result" | grep -F 'NEXUS_SYNC_APPLY_PASS' >/dev/null; then
  echo 'Partial synchronization returned overall PASS' >&2; exit 1
fi
cmp -s "$PACKAGE/nexus-sync.service.three-mirror" "$UNIT_DIR/nexus-sync.service"

# Qualified transition and reapplication produce exactly the intended unit, no duplicate commands.
: > "$TMP/mutations"
result=$(run_installer --apply-from-three)
[ "$(printf '%s\n' "$result" | head -n1)" -eq 0 ]
printf '%s\n' "$result" | grep -Fx 'NEXUS_SYNC_APPLY_PASS' >/dev/null
[ "$(wc -l < "$TMP/mutations")" -eq 4 ]
cmp -s "$PACKAGE/nexus-sync.service" "$UNIT_DIR/nexus-sync.service"
cp "$UNIT_DIR/nexus-sync.service" "$TMP/installed-first-apply"
result=$(run_installer --apply-from-three)
[ "$(printf '%s\n' "$result" | head -n1)" -eq 0 ]
cmp -s "$TMP/installed-first-apply" "$UNIT_DIR/nexus-sync.service"
[ "$(grep -c '^ExecStart=' "$UNIT_DIR/nexus-sync.service")" -eq 4 ]
result=$(run_installer --preflight)
[ "$(printf '%s\n' "$result" | head -n1)" -eq 0 ]
printf 'NEXUS_SYNC_TRANSITION_REGRESSION_PASS\n'
