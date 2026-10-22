#!/usr/bin/env bash
set -euo pipefail
umask 077
# Disposable offline qualification only; NEVER run this against production.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel)
TARGET_HOST=$OPENCLAW_BIN
PREDECESSOR_HOST=$PREDECESSOR_OPENCLAW_BIN
[ -x "$TARGET_HOST" ] && [ -x "$PREDECESSOR_HOST" ] || { echo "Pinned hosts missing" >&2; exit 2; }
TARGET_HOST_VERSION=$("$TARGET_HOST" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
eval "$(node "$ROOT/deploy-support.mjs" release-env "$REPO_ROOT" "$ROOT/release.json" "$TARGET_HOST_VERSION")"
[ "$TARGET_HOST_VERSION" = "$TARGET_OPENCLAW_VERSION" ] || exit 2
[ "$("$PREDECESSOR_HOST" --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" = "$PREDECESSOR_OPENCLAW_VERSION" ] || exit 2
TEST_ROOT=$(mktemp -d /tmp/training-active-upgrade-qualification.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
HOME_DIR="$TEST_ROOT/home"
STATE_DIR="$TEST_ROOT/state"
CONFIG="$STATE_DIR/openclaw.json"
DB="$STATE_DIR/data/training/training.sqlite3"
WORKSPACE="$STATE_DIR/workspace-training"
mkdir -p "$HOME_DIR" "$STATE_DIR" "$WORKSPACE" "$TEST_ROOT/training-agent"
printf '{}\n' > "$CONFIG"
oc() {
  local host=$1; shift
  HOME="$HOME_DIR" OPENCLAW_HOME="$HOME_DIR" OPENCLAW_STATE_DIR="$STATE_DIR" OPENCLAW_CONFIG_PATH="$CONFIG" "$host" "$@"
}
assert_plugin() {
  local host=$1 want=$2
  oc "$host" plugins list --json | node -e '
    let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{
      const p=(JSON.parse(s).plugins||[]).filter(x=>x.id==="training");
      if(p.length!==1 || p[0].version!==process.argv[1] || p[0].enabled!==true || p[0].status!=="loaded")process.exit(2);
    });' "$want"
}
assert_training_policy() {
  node - "$CONFIG" "$DB" <<'NODE'
const fs=require('node:fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const e=c?.agents?.entries;
const a=Array.isArray(e)?e:Object.entries(e||{}).map(([id,x])=>({id,...x}));
const p=c?.plugins?.entries?.training;
if(a.filter(x=>x?.id==='training').length!==1 ||
   !Array.isArray(c?.plugins?.allow) || c.plugins.allow.filter(x=>x==='training').length!==1 ||
   p?.enabled!==true || p?.config?.databasePath!==process.argv[3])process.exit(2);
NODE
}
# Historical predecessor host + real release artifact, synthetic Store and active policy.
oc "$PREDECESSOR_HOST" agents add training --workspace "$WORKSPACE" --agent-dir "$TEST_ROOT/training-agent" --model openai/gpt-5.6-luna --non-interactive --json >/dev/null
oc "$PREDECESSOR_HOST" plugins install --force --no-enable --accept-capabilities "$PREDECESSOR_ARTIFACT" >/dev/null
node "$ROOT/migration/import.mjs" "$DB" "$ROOT/migration/fixtures/synthetic.json" >/dev/null
PATCH=$(node -e 'process.stdout.write(JSON.stringify({plugins:{allow:["training"],entries:{training:{enabled:true,config:{databasePath:process.argv[1]}}}}}))' "$DB")
printf '%s\n' "$PATCH" | oc "$PREDECESSOR_HOST" config patch --stdin >/dev/null
oc "$PREDECESSOR_HOST" config validate >/dev/null
assert_training_policy
assert_plugin "$PREDECESSOR_HOST" "$PREDECESSOR_PLUGIN_VERSION"
# Existing stage-only path MUST reject the activated state.
set +e
OPENCLAW_BIN="$TARGET_HOST" bash "$ROOT/deploy.sh" --test-root "$TEST_ROOT" --preflight >"$TEST_ROOT/stage.out" 2>"$TEST_ROOT/stage.err"
STAGE_EXIT=$?
set -e
[ "$STAGE_EXIT" -ne 0 ] && grep -q 'stage-only deploy refuses to modify it' "$TEST_ROOT/stage.err" || { echo "stage-only guard bypass" >&2; exit 1; }
DB_SHA=$(sha256sum "$DB" | awk '{print $1}')
# Official plugin replacement, preserving activation policy and Store.
oc "$TARGET_HOST" plugins install --force --no-enable --accept-capabilities "$ARTIFACT" >/dev/null
oc "$TARGET_HOST" config validate >/dev/null
assert_training_policy
assert_plugin "$TARGET_HOST" "$TARGET_PLUGIN_VERSION"
[ "$(sha256sum "$STATE_DIR/extensions/training/dist/plugin.js" | awk '{print $1}')" = "$TARGET_RUNTIME_ENTRY_SHA" ] || { echo "target artifact drift" >&2; exit 1; }
[ "$(sha256sum "$DB" | awk '{print $1}')" = "$DB_SHA" ] || { echo "Store changed on upgrade" >&2; exit 1; }
# Exact frozen predecessor rollback on target host must succeed, never assumed.
oc "$TARGET_HOST" plugins install --force --no-enable --accept-capabilities "$PREDECESSOR_ARTIFACT" >/dev/null
oc "$TARGET_HOST" config validate >/dev/null
assert_training_policy
assert_plugin "$TARGET_HOST" "$PREDECESSOR_PLUGIN_VERSION"
[ "$(sha256sum "$STATE_DIR/extensions/training/dist/plugin.js" | awk '{print $1}')" = "$PREDECESSOR_RUNTIME_ENTRY_SHA" ] || { echo "rollback artifact drift" >&2; exit 1; }
[ "$(sha256sum "$DB" | awk '{print $1}')" = "$DB_SHA" ] || { echo "Store changed on rollback" >&2; exit 1; }
echo TRAINING_ACTIVE_UPGRADE_OFFLINE_QUALIFICATION_PASS
