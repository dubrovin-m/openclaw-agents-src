#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY="$ROOT/deploy.sh"
OPENCLAW_BIN=${OPENCLAW_BIN:-$(command -v openclaw)}
PREDECESSOR_OPENCLAW_BIN=${PREDECESSOR_OPENCLAW_BIN:-}
TARGET_VERSION=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.plugin.version)' "$ROOT/release.json")
PREDECESSOR_VERSION=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.predecessor.plugin.version)' "$ROOT/release.json")
PREDECESSOR_SOURCE=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.predecessor.source_revision)' "$ROOT/release.json")
PREDECESSOR_ARTIFACT=$(node -e 'const path=require("path"),r=require(process.argv[1]);process.stdout.write(path.resolve(path.dirname(process.argv[1]),r.predecessor.plugin.artifact))' "$ROOT/release.json")
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel)
TMP=$(mktemp -d /tmp/training-deploy-test.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
fail(){ echo "TRAINING_DEPLOY_TEST_FAIL: $*" >&2; exit 1; }

oc(){
  local r=$1; shift
  HOME="$r/home" OPENCLAW_HOME="$r/home" OPENCLAW_STATE_DIR="$r/state" OPENCLAW_CONFIG_PATH="$r/state/openclaw.json" "$OPENCLAW_BIN" "$@"
}
oc_predecessor(){
  local r=$1; shift
  [ -n "$PREDECESSOR_OPENCLAW_BIN" ] && [ -x "$PREDECESSOR_OPENCLAW_BIN" ] || fail "qualified predecessor OpenClaw binary unavailable"
  HOME="$r/home" OPENCLAW_HOME="$r/home" OPENCLAW_STATE_DIR="$r/state" OPENCLAW_CONFIG_PATH="$r/state/openclaw.json" "$PREDECESSOR_OPENCLAW_BIN" "$@"
}
init_root(){
  local r=$1 host=${2:-target}
  mkdir -p "$r/home" "$r/state" "$r/sentinel-workspace" "$r/sentinel-agent"
  printf '%s\n' '{}' > "$r/state/openclaw.json"
  if [ "$host" = predecessor ]; then
    oc_predecessor "$r" agents add sentinel \
      --workspace "$r/sentinel-workspace" \
      --agent-dir "$r/sentinel-agent" \
      --model openai/gpt-5.6-luna \
      --non-interactive --json >/dev/null
    oc_predecessor "$r" config validate >/dev/null
  else
    oc "$r" agents add sentinel \
      --workspace "$r/sentinel-workspace" \
      --agent-dir "$r/sentinel-agent" \
      --model openai/gpt-5.6-luna \
      --non-interactive --json >/dev/null
    oc "$r" config validate >/dev/null
  fi
}
assert_sentinel(){
  local r=$1
  node - "$r/state/openclaw.json" "$r/sentinel-workspace" <<'NODE'
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),want=process.argv[3],e=c?.agents?.entries;
const rows=Array.isArray(e)?e:Object.entries(e||{}).map(([id,x])=>({id,...x}));
const matches=rows.filter(x=>x?.id==='sentinel'||x?.name==='sentinel');
if(matches.length!==1||matches[0].workspace!==want)process.exit(1);
NODE
}
assert_no_training_agent_or_binding(){
  local r=$1
  node - "$r/state/openclaw.json" <<'NODE'
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),e=c?.agents?.entries;
const rows=Array.isArray(e)?e:Object.entries(e||{}).map(([id,x])=>({id,...x}));
if(rows.some(x=>x?.id==='training'||x?.name==='training'||String(x?.workspace||'').endsWith('/workspace-training')))process.exit(1);
if((Array.isArray(c?.bindings)?c.bindings:[]).some(x=>x?.agentId==='training'))process.exit(2);
NODE
}
assert_plugin_absent(){
  local r=$1
  local n
  n=$(oc "$r" plugins list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.stdout.write(String((x.plugins||[]).filter(p=>p.id==="training").length))})')
  [ "$n" = 0 ] || fail "Training plugin remains installed"
}
assert_plugin_version(){
  local r=$1 version=$2 host=${3:-target} db="$1/state/data/training/training.sqlite3" json
  if [ "$host" = predecessor ]; then
    json=$(oc_predecessor "$r" plugins list --json)
  else
    json=$(oc "$r" plugins list --json)
  fi
  printf '%s' "$json" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const x=JSON.parse(s),root=process.argv[1],version=process.argv[2],m=(x.plugins||[]).filter(p=>p.id==="training");
  if(m.length!==1||m[0].version!==version||m[0].enabled!==false||m[0].status!=="disabled"||m[0].rootDir!==root)process.exit(1);
})' "$r/state/extensions/training" "$version"
  node - "$r/state/openclaw.json" "$db" <<'NODE'
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),db=process.argv[3],p=c?.plugins?.entries?.training,allow=Array.isArray(c?.plugins?.allow)?c.plugins.allow:[];
if(!p||p.enabled!==false||p?.config?.databasePath!==db||allow.includes('training'))process.exit(1);
NODE
}
assert_plugin_staged(){ assert_plugin_version "$1" "$TARGET_VERSION"; }
stage_predecessor(){
  local r=$1 db="$1/state/data/training/training.sqlite3" patch
  init_root "$r" predecessor
  mkdir -p "$r/state/workspace-training"
  for name in AGENTS.md HEARTBEAT.md IDENTITY.md SOUL.md USER.md; do
    git -C "$REPO_ROOT" show "$PREDECESSOR_SOURCE:agents/training/workspace/$name" > "$r/state/workspace-training/$name"
    chmod 600 "$r/state/workspace-training/$name"
  done
  oc_predecessor "$r" plugins install --force --no-enable --accept-capabilities "$PREDECESSOR_ARTIFACT" >/dev/null
  patch=$(node -e 'process.stdout.write(JSON.stringify({plugins:{entries:{training:{enabled:false,config:{databasePath:process.argv[1]}}}}}))' "$db")
  printf '%s\n' "$patch" | oc_predecessor "$r" config patch --stdin >/dev/null
  oc_predecessor "$r" config validate >/dev/null
  # Inspect pre-upgrade with 2026.9.7; subsequent commands use the upgraded 2026.9.8 host.
  assert_plugin_version "$r" "$PREDECESSOR_VERSION" predecessor
  node "$ROOT/deploy-support.mjs" workspace-exact "$r/state/workspace-training" "$ROOT/release.json" predecessor >/dev/null
  assert_no_training_agent_or_binding "$r"
  [ ! -e "$db" ] || fail "predecessor staging created Training DB"
}

grep -Fq 'plugins install --force --no-enable --accept-capabilities' "$DEPLOY" || fail "stage deploy does not use OpenClaw no-enable install"
grep -Fq 'OPENCLAW_BIN=${OPENCLAW_BIN:-$(command -v openclaw || true)}' "$DEPLOY" || fail "deploy entrypoint does not honor explicit qualified host binary"
grep -Fq 'config patch --stdin' "$DEPLOY" || fail "stage deploy does not atomically patch disabled plugin config"
! grep -Fq 'config set plugins.entries.training' "$DEPLOY" || fail "stage deploy uses non-atomic Training config writes"

LEGACY_CONFIG="$TMP/legacy-array.json"
cat > "$LEGACY_CONFIG" <<JSON
{"agents":{"entries":[{"id":"sentinel","workspace":"/tmp/sentinel"}]},"bindings":[],"plugins":{"entries":{}}}
JSON
eval "$(node "$ROOT/deploy-support.mjs" config-env "$LEGACY_CONFIG" "$TMP/legacy-training.sqlite3")"
[ "$TRAINING_AGENT_COUNT" -eq 0 ] && [ "$TRAINING_BINDING_COUNT" -eq 0 ] && [ "$TRAINING_PLUGIN_CONFIG_PRESENT" -eq 0 ] || fail "legacy array config inspection failed"

SUCCESS="$TMP/success"
init_root "$SUCCESS"
assert_sentinel "$SUCCESS"
bash "$DEPLOY" --test-root "$SUCCESS" --preflight | grep -q 'TRAINING_DEPLOY_PREFLIGHT_PASS state=ABSENT' || fail "ABSENT preflight failed"
bash "$DEPLOY" --test-root "$SUCCESS" --apply | grep -q 'TRAINING_DEPLOY_STAGE_PASS' || fail "stage apply failed"
oc "$SUCCESS" config validate >/dev/null
assert_sentinel "$SUCCESS"
assert_no_training_agent_or_binding "$SUCCESS"
assert_plugin_staged "$SUCCESS"
node "$ROOT/deploy-support.mjs" workspace-exact "$SUCCESS/state/workspace-training" "$ROOT/release.json" || fail "workspace target mismatch"
[ ! -e "$SUCCESS/state/data/training/training.sqlite3" ] || fail "stage created Training DB"
CONFIG_AFTER=$(sha256sum "$SUCCESS/state/openclaw.json" | awk '{print $1}')
bash "$DEPLOY" --test-root "$SUCCESS" --apply | grep -q 'TRAINING_DEPLOY_ALREADY_STAGED' || fail "repeat stage was not idempotent"
[ "$CONFIG_AFTER" = "$(sha256sum "$SUCCESS/state/openclaw.json" | awk '{print $1}')" ] || fail "repeat stage changed config"

ROLLBACK="$TMP/rollback"
init_root "$ROLLBACK"
BEFORE=$(sha256sum "$ROLLBACK/state/openclaw.json" | awk '{print $1}')
set +e
TRAINING_DEPLOY_TEST_FAIL_STAGE=after-config bash "$DEPLOY" --test-root "$ROLLBACK" --apply >"$TMP/rollback.out" 2>"$TMP/rollback.err"
CODE=$?
set -e
[ "$CODE" -eq 97 ] || { cat "$TMP/rollback.out" "$TMP/rollback.err" >&2; fail "synthetic failure returned $CODE"; }
grep -q 'TRAINING_DEPLOY_ROLLED_BACK' "$TMP/rollback.err" || fail "rollback marker missing"
[ "$BEFORE" = "$(sha256sum "$ROLLBACK/state/openclaw.json" | awk '{print $1}')" ] || fail "rollback did not restore exact config"
[ ! -e "$ROLLBACK/state/workspace-training" ] || fail "rollback left Training workspace"
[ ! -e "$ROLLBACK/state/extensions/training" ] || fail "rollback left Training extension"
[ ! -e "$ROLLBACK/state/data/training/training.sqlite3" ] || fail "rollback left Training DB"
assert_sentinel "$ROLLBACK"
assert_no_training_agent_or_binding "$ROLLBACK"
assert_plugin_absent "$ROLLBACK"
oc "$ROLLBACK" config validate >/dev/null

seed_existing_training_store(){
  local db="$1/state/data/training/training.sqlite3"
  mkdir -p "$(dirname "$db")"
  python3 - "$db" <<'PYDB'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.execute('PRAGMA user_version = 2')
db.execute('CREATE TABLE synthetic_training_history (id INTEGER PRIMARY KEY, description TEXT NOT NULL)')
db.execute('INSERT INTO synthetic_training_history(description) VALUES (?)',('synthetic pre-existing record',))
db.commit()
db.close()
PYDB
}

UPGRADE="$TMP/upgrade"
stage_predecessor "$UPGRADE"
seed_existing_training_store "$UPGRADE"
DATA_BEFORE=$(sha256sum "$UPGRADE/state/data/training/training.sqlite3" | awk '{print $1}')
assert_sentinel "$UPGRADE"
OPENCLAW_BIN="$PREDECESSOR_OPENCLAW_BIN" bash "$DEPLOY" --test-root "$UPGRADE" --preflight | grep -q 'TRAINING_DEPLOY_PREFLIGHT_PASS state=STAGED_PREDECESSOR' || fail "predecessor old-host preflight failed"
OPENCLAW_BIN="$PREDECESSOR_OPENCLAW_BIN" bash "$DEPLOY" --test-root "$UPGRADE" --apply | grep -q 'TRAINING_DEPLOY_STAGE_PASS' || fail "old-host target staging failed"
[ "$DATA_BEFORE" = "$(sha256sum "$UPGRADE/state/data/training/training.sqlite3" | awk '{print $1}')" ] || fail "existing Training Store changed during host bridge staging"
# Only after staging the new compatible disabled plugin, cross the OpenClaw host boundary.
bash "$DEPLOY" --test-root "$UPGRADE" --preflight | grep -q 'TRAINING_DEPLOY_PREFLIGHT_PASS state=STAGED_TARGET' || fail "new-host staged target preflight failed"
bash "$DEPLOY" --test-root "$UPGRADE" --apply | grep -q 'TRAINING_DEPLOY_ALREADY_STAGED' || fail "new-host staged target no-op failed"
assert_sentinel "$UPGRADE"
assert_no_training_agent_or_binding "$UPGRADE"
assert_plugin_staged "$UPGRADE"
node "$ROOT/deploy-support.mjs" workspace-exact "$UPGRADE/state/workspace-training" "$ROOT/release.json" target >/dev/null || fail "updated workspace target mismatch"
[ "$DATA_BEFORE" = "$(sha256sum "$UPGRADE/state/data/training/training.sqlite3" | awk '{print $1}')" ] || fail "existing Training Store changed across host bridge"

UPGRADE_ROLLBACK="$TMP/upgrade-rollback"
stage_predecessor "$UPGRADE_ROLLBACK"
seed_existing_training_store "$UPGRADE_ROLLBACK"
ROLLBACK_DATA_BEFORE=$(sha256sum "$UPGRADE_ROLLBACK/state/data/training/training.sqlite3" | awk '{print $1}')
UPGRADE_BEFORE=$(sha256sum "$UPGRADE_ROLLBACK/state/openclaw.json" | awk '{print $1}')
PREDECESSOR_WORKSPACE_BEFORE=$(find "$UPGRADE_ROLLBACK/state/workspace-training" -maxdepth 1 -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
set +e
OPENCLAW_BIN="$PREDECESSOR_OPENCLAW_BIN" TRAINING_DEPLOY_TEST_FAIL_STAGE=after-config bash "$DEPLOY" --test-root "$UPGRADE_ROLLBACK" --apply >"$TMP/upgrade-rollback.out" 2>"$TMP/upgrade-rollback.err"
UPGRADE_CODE=$?
set -e
[ "$UPGRADE_CODE" -eq 97 ] || { cat "$TMP/upgrade-rollback.out" "$TMP/upgrade-rollback.err" >&2; fail "predecessor synthetic failure returned $UPGRADE_CODE"; }
grep -q 'TRAINING_DEPLOY_ROLLED_BACK' "$TMP/upgrade-rollback.err" || fail "predecessor rollback marker missing"
[ "$ROLLBACK_DATA_BEFORE" = "$(sha256sum "$UPGRADE_ROLLBACK/state/data/training/training.sqlite3" | awk '{print $1}')" ] || fail "Training Store was lost or modified during rollback"
[ "$UPGRADE_BEFORE" = "$(sha256sum "$UPGRADE_ROLLBACK/state/openclaw.json" | awk '{print $1}')" ] || fail "predecessor rollback did not restore exact config"
[ "$PREDECESSOR_WORKSPACE_BEFORE" = "$(find "$UPGRADE_ROLLBACK/state/workspace-training" -maxdepth 1 -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')" ] || fail "predecessor rollback did not restore exact workspace"
assert_plugin_version "$UPGRADE_ROLLBACK" "$PREDECESSOR_VERSION" predecessor
node "$ROOT/deploy-support.mjs" workspace-exact "$UPGRADE_ROLLBACK/state/workspace-training" "$ROOT/release.json" predecessor >/dev/null || fail "predecessor rollback workspace mismatch"
assert_sentinel "$UPGRADE_ROLLBACK"
assert_no_training_agent_or_binding "$UPGRADE_ROLLBACK"
oc_predecessor "$UPGRADE_ROLLBACK" config validate >/dev/null

echo TRAINING_DEPLOY_TEST_PASS
