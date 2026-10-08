#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)
RELEASE_FILE="$ROOT/release.json"
SUPPORT="$ROOT/deploy-support.mjs"
RUNTIME_CONTRACT="${REPO_ROOT:+$REPO_ROOT/runtime-contract.json}"
RUNTIME_HELPER="${REPO_ROOT:+$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs}"

MODE=""
TEST_ROOT=""
if [ "$#" -eq 1 ] && { [ "$1" = "--preflight" ] || [ "$1" = "--apply" ]; }; then
  MODE=${1#--}
elif [ "$#" -eq 3 ] && [ "$1" = "--test-root" ] && { [ "$3" = "--preflight" ] || [ "$3" = "--apply" ]; }; then
  TEST_ROOT=$2
  MODE=${3#--}
else
  echo "Usage: $0 --preflight|--apply" >&2
  echo "       $0 --test-root /absolute/path --preflight|--apply" >&2
  exit 2
fi

fail(){ echo "TRAINING_DEPLOY_FAIL: $*" >&2; exit 2; }
require_cmd(){ command -v "$1" >/dev/null 2>&1 || fail "Required command unavailable: $1"; }
for c in node git sha256sum tar realpath install mkdir rm mktemp cp mv flock grep awk; do require_cmd "$c"; done
[ -n "$REPO_ROOT" ] || fail "Repository root unavailable"
[ -f "$RELEASE_FILE" ] && [ -f "$SUPPORT" ] || fail "Training release support missing"
[ -f "$RUNTIME_CONTRACT" ] && [ -f "$RUNTIME_HELPER" ] || fail "Runtime contract source missing"
EXPECTED_OPENCLAW_VERSION=$(node "$RUNTIME_HELPER" openclaw-version "$RUNTIME_CONTRACT") || fail "Invalid runtime contract"
node "$RUNTIME_HELPER" check-node "$RUNTIME_CONTRACT" "$(node --version)" >/dev/null || fail "Unsupported Node runtime"
eval "$(node "$SUPPORT" release-env "$REPO_ROOT" "$RELEASE_FILE" "$EXPECTED_OPENCLAW_VERSION")" || fail "Invalid Training release"

OPENCLAW_BIN=${OPENCLAW_BIN:-$(command -v openclaw || true)}
[ -n "$OPENCLAW_BIN" ] || fail "Required command unavailable: openclaw"
[ -x "$OPENCLAW_BIN" ] || fail "OpenClaw binary is not executable: $OPENCLAW_BIN"

if [ -n "$TEST_ROOT" ]; then
  case "$TEST_ROOT" in /*) ;; *) fail "--test-root must be absolute" ;; esac
  mkdir -p "$TEST_ROOT"
  TEST_ROOT=$(realpath -e "$TEST_ROOT")
  REAL_HOME=$(realpath -e "$HOME")
  case "$TEST_ROOT" in
    /|"$REAL_HOME"|"$REAL_HOME"/.openclaw|"$REAL_HOME"/.openclaw/*)
      fail "Refusing unsafe test root: $TEST_ROOT" ;;
  esac
  HOME_DIR="$TEST_ROOT/home"
  STATE_DIR="$TEST_ROOT/state"
  CONFIG="$STATE_DIR/openclaw.json"
  LOCK_FILE="$TEST_ROOT/training-stage.lock"
else
  HOME_DIR="$HOME"
  STATE_DIR="$HOME_DIR/.openclaw"
  CONFIG="$STATE_DIR/openclaw.json"
  LOCK_FILE="$STATE_DIR/training-stage.lock"
fi
WORKSPACE="$STATE_DIR/workspace-training"
EXTENSION_DIR="$STATE_DIR/extensions/training"
DB="$STATE_DIR/data/training/training.sqlite3"

oc(){
  if [ -n "$TEST_ROOT" ]; then
    HOME="$HOME_DIR" OPENCLAW_HOME="$HOME_DIR" OPENCLAW_STATE_DIR="$STATE_DIR" OPENCLAW_CONFIG_PATH="$CONFIG" "$OPENCLAW_BIN" "$@"
  else
    "$OPENCLAW_BIN" "$@"
  fi
}

[ -f "$CONFIG" ] || fail "OpenClaw config missing: $CONFIG"
LIVE_OPENCLAW_VERSION=$(oc --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ "$LIVE_OPENCLAW_VERSION" != "$TARGET_OPENCLAW_VERSION" ]; then
  [ "$PREDECESSOR_PRESENT" = 1 ] && [ -n "$PREDECESSOR_OPENCLAW_VERSION" ] && \
    [ "$LIVE_OPENCLAW_VERSION" = "$PREDECESSOR_OPENCLAW_VERSION" ] || \
    fail "OpenClaw version mismatch: live=${LIVE_OPENCLAW_VERSION:-unknown} target=$TARGET_OPENCLAW_VERSION predecessor=${PREDECESSOR_OPENCLAW_VERSION:-none}"
fi
oc config validate >/dev/null || fail "Current OpenClaw config is invalid"

# Staging preserves an existing, non-authoritative Training Store byte-for-byte.
DB_WAS_PRESENT=0
DB_ORIGINAL_SHA=""
if [ -e "$DB" ] || [ -L "$DB" ]; then
  [ -f "$DB" ] && [ ! -L "$DB" ] && [ -O "$DB" ] || fail "Unsafe pre-existing Training database"
  DB_WAS_PRESENT=1
  DB_ORIGINAL_SHA=$(sha256sum "$DB" | awk '{print $1}')
fi
verify_db_preserved() {
  if [ "$DB_WAS_PRESENT" -eq 1 ]; then
    [ -f "$DB" ] && [ ! -L "$DB" ] && [ -O "$DB" ] || return 1
    [ "$(sha256sum "$DB" | awk '{print $1}')" = "$DB_ORIGINAL_SHA" ]
  else
    [ ! -e "$DB" ] && [ ! -L "$DB" ]
  fi
}

STATE=""
assess(){
  eval "$(node "$SUPPORT" config-env "$CONFIG" "$DB")" || fail "Unable to inspect Training config state"
  local plugin_json
  plugin_json=$(oc plugins list --json) || fail "Unable to inspect OpenClaw plugins"
  eval "$(printf '%s' "$plugin_json" | node "$SUPPORT" plugin-env "$TARGET_PLUGIN_ID" "$TARGET_PLUGIN_VERSION" "$EXTENSION_DIR" "$TARGET_RUNTIME_ENTRY_SHA" TARGET)" || fail "Unable to inspect target Training plugin state"
  if [ "$PREDECESSOR_PRESENT" = "1" ]; then
    eval "$(printf '%s' "$plugin_json" | node "$SUPPORT" plugin-env "$TARGET_PLUGIN_ID" "$PREDECESSOR_PLUGIN_VERSION" "$EXTENSION_DIR" "$PREDECESSOR_RUNTIME_ENTRY_SHA" PREDECESSOR)" || fail "Unable to inspect predecessor Training plugin state"
  else
    PREDECESSOR_PLUGIN_COUNT=0
    PREDECESSOR_PLUGIN_EXACT=0
    PREDECESSOR_PLUGIN_ENABLED=0
  fi
  local target_workspace_exact=0 predecessor_workspace_exact=0 db_present=0 extension_present=0
  node "$SUPPORT" workspace-exact "$WORKSPACE" "$RELEASE_FILE" target >/dev/null 2>&1 && target_workspace_exact=1 || true
  if [ "$PREDECESSOR_PRESENT" = "1" ]; then
    node "$SUPPORT" workspace-exact "$WORKSPACE" "$RELEASE_FILE" predecessor >/dev/null 2>&1 && predecessor_workspace_exact=1 || true
  fi
  [ -e "$DB" ] && db_present=1 || true
  [ -e "$EXTENSION_DIR" ] && extension_present=1 || true

  local common_staged=0
  if [ "$TRAINING_AGENT_COUNT" -eq 0 ] && [ "$TRAINING_BINDING_COUNT" -eq 0 ] && \
     [ "$TRAINING_PLUGIN_CONFIG_PRESENT" -eq 1 ] && [ "$TRAINING_PLUGIN_ENABLED" -eq 0 ] && \
     [ "$TRAINING_PLUGIN_DB_EXACT" -eq 1 ] && [ "$TRAINING_ALLOW_COUNT" -eq 0 ]; then
    common_staged=1
  fi

  if [ "$common_staged" -eq 1 ] && [ "$TARGET_PLUGIN_COUNT" -eq 1 ] && [ "$TARGET_PLUGIN_EXACT" -eq 1 ] && [ "$target_workspace_exact" -eq 1 ]; then
    verify_db_preserved || fail "Training database changed during state inspection"
    STATE="STAGED_TARGET"
    return 0
  fi

  if [ "$PREDECESSOR_PRESENT" = "1" ] && [ "$common_staged" -eq 1 ] && \
     [ "$PREDECESSOR_PLUGIN_COUNT" -eq 1 ] && [ "$PREDECESSOR_PLUGIN_EXACT" -eq 1 ] && [ "$predecessor_workspace_exact" -eq 1 ]; then
    verify_db_preserved || fail "Training database changed during state inspection"
    STATE="STAGED_PREDECESSOR"
    return 0
  fi

  if [ "$TRAINING_AGENT_COUNT" -eq 0 ] && [ "$TRAINING_BINDING_COUNT" -eq 0 ] && \
     [ "$TRAINING_PLUGIN_CONFIG_PRESENT" -eq 0 ] && [ "$TRAINING_ALLOW_COUNT" -eq 0 ] && \
     [ "$TARGET_PLUGIN_COUNT" -eq 0 ] && [ "$target_workspace_exact" -eq 0 ] && [ "$extension_present" -eq 0 ] && [ "$db_present" -eq 0 ]; then
    STATE="ABSENT"
    return 0
  fi

  STATE="PARTIAL_OR_ACTIVE"
  return 0
}

assess
[ "$STATE" != "PARTIAL_OR_ACTIVE" ] || fail "Training runtime is partial or already active; stage-only deploy refuses to modify it"

if [ "$MODE" = "preflight" ]; then
  echo "TRAINING_DEPLOY_PREFLIGHT_PASS state=$STATE source=$SOURCE_REVISION plugin=$TARGET_PLUGIN_VERSION"
  exit 0
fi

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "Another Training deployment is running"
assess
[ "$STATE" != "PARTIAL_OR_ACTIVE" ] || fail "Training runtime changed after preflight"
if [ "$STATE" = "STAGED_TARGET" ]; then
  verify_db_preserved || fail "Training database changed before staged no-op"
  echo "TRAINING_DEPLOY_ALREADY_STAGED source=$SOURCE_REVISION plugin=$TARGET_PLUGIN_VERSION"
  exit 0
fi

ORIGINAL_STATE="$STATE"
BACKUP_CONFIG=$(mktemp "${CONFIG}.training-stage-before.XXXXXX")
cp -p "$CONFIG" "$BACKUP_CONFIG"
WORKSPACE_TMP=$(mktemp -d "${STATE_DIR}/.workspace-training.stage.XXXXXX")
WORKSPACE_BACKUP=""
if [ "$ORIGINAL_STATE" = "STAGED_PREDECESSOR" ]; then
  WORKSPACE_BACKUP=$(mktemp -d "${STATE_DIR}/.workspace-training.predecessor.XXXXXX")
  cp -a "$WORKSPACE/." "$WORKSPACE_BACKUP/"
fi
MUTATION_STARTED=1

rollback(){
  set +e
  if [ "$ORIGINAL_STATE" = "STAGED_PREDECESSOR" ]; then
    oc plugins install --force --no-enable --accept-capabilities "$PREDECESSOR_ARTIFACT" >/dev/null 2>&1 || true
    rm -rf "$WORKSPACE"
    install -d -m 700 "$WORKSPACE"
    cp -a "$WORKSPACE_BACKUP/." "$WORKSPACE/" 2>/dev/null || true
  else
    if [ "$MUTATION_STARTED" -eq 1 ]; then
      oc plugins uninstall training --force >/dev/null 2>&1 || true
    fi
    rm -rf "$EXTENSION_DIR" "$WORKSPACE"
  fi
  rm -rf "$WORKSPACE_TMP"
  cp -p "$BACKUP_CONFIG" "$CONFIG"
  # Retain any pre-existing Store on both success and rollback.
  if [ "$DB_WAS_PRESENT" -eq 0 ]; then
    rm -f "$DB"
    rmdir "$(dirname "$DB")" >/dev/null 2>&1 || true
  fi
  oc config validate >/dev/null 2>&1 || true
  rm -f "$BACKUP_CONFIG"
  [ -z "$WORKSPACE_BACKUP" ] || rm -rf "$WORKSPACE_BACKUP"
  verify_db_preserved || fail "Existing Training database changed during rollback; manual recovery required"
  set -e
}

set +e
(
  set -euo pipefail
  install -d -m 700 "$WORKSPACE_TMP"
  for name in AGENTS.md HEARTBEAT.md IDENTITY.md SOUL.md USER.md; do
    install -m 600 "$ROOT/workspace/$name" "$WORKSPACE_TMP/$name"
  done
  rm -rf "$WORKSPACE"
  mv "$WORKSPACE_TMP" "$WORKSPACE"

  oc plugins install --force --no-enable --accept-capabilities "$ARTIFACT"
  PLUGIN_PATCH=$(node -e 'process.stdout.write(JSON.stringify({plugins:{entries:{training:{enabled:false,config:{databasePath:process.argv[1]}}}}}))' "$DB")
  printf '%s\n' "$PLUGIN_PATCH" | oc config patch --stdin >/dev/null
  oc config validate >/dev/null

  if [ -n "$TEST_ROOT" ] && [ "${TRAINING_DEPLOY_TEST_FAIL_STAGE:-}" = "after-config" ]; then
    echo "synthetic Training deployment failure" >&2
    exit 97
  fi

  assess
  [ "$STATE" = "STAGED_TARGET" ] || { echo "Training target state verification failed: $STATE" >&2; exit 98; }
  verify_db_preserved || { echo "Training database changed during staging" >&2; exit 99; }
)
CODE=$?
set -e

if [ "$CODE" -ne 0 ]; then
  rollback
  assess
  [ "$STATE" = "$ORIGINAL_STATE" ] || fail "Deployment failed and rollback did not restore predecessor state: expected=$ORIGINAL_STATE actual=$STATE"
  echo "TRAINING_DEPLOY_ROLLED_BACK code=$CODE" >&2
  exit "$CODE"
fi

verify_db_preserved || fail "Training database changed after staging"
rm -f "$BACKUP_CONFIG"
rm -rf "$WORKSPACE_TMP"
[ -z "$WORKSPACE_BACKUP" ] || rm -rf "$WORKSPACE_BACKUP"
echo "TRAINING_DEPLOY_STAGE_PASS source=$SOURCE_REVISION plugin=$TARGET_PLUGIN_VERSION"
