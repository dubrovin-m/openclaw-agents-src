#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY="$ROOT/deploy.sh"
OPENCLAW_BIN=$(command -v openclaw)
TMP=$(mktemp -d /tmp/training-deploy-test.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
fail(){ echo "TRAINING_DEPLOY_TEST_FAIL: $*" >&2; exit 1; }

oc(){
  local r=$1; shift
  HOME="$r/home" OPENCLAW_HOME="$r/home" OPENCLAW_STATE_DIR="$r/state" OPENCLAW_CONFIG_PATH="$r/state/openclaw.json" "$OPENCLAW_BIN" "$@"
}
init_root(){
  local r=$1
  mkdir -p "$r/home" "$r/state" "$r/sentinel-workspace" "$r/sentinel-agent"
  printf '%s\n' '{}' > "$r/state/openclaw.json"
  oc "$r" agents add sentinel \
    --workspace "$r/sentinel-workspace" \
    --agent-dir "$r/sentinel-agent" \
    --model openai/gpt-5.6-luna \
    --non-interactive --json >/dev/null
  oc "$r" config validate >/dev/null
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
assert_plugin_staged(){
  local r=$1 db="$1/state/data/training/training.sqlite3"
  oc "$r" plugins list --json | node - "$r/state/extensions/training" <<'NODE'
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s),root=process.argv[2],m=(x.plugins||[]).filter(p=>p.id==='training');if(m.length!==1||m[0].version!=='0.1.0'||m[0].enabled!==false||m[0].status!=='disabled'||m[0].rootDir!==root)process.exit(1);});
NODE
  node - "$r/state/openclaw.json" "$db" <<'NODE'
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),db=process.argv[3],p=c?.plugins?.entries?.training,allow=Array.isArray(c?.plugins?.allow)?c.plugins.allow:[];
if(!p||p.enabled!==false||p?.config?.databasePath!==db||allow.includes('training'))process.exit(1);
NODE
}

grep -Fq 'plugins install --force --no-enable --accept-capabilities' "$DEPLOY" || fail "stage deploy does not use OpenClaw no-enable install"
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

echo TRAINING_DEPLOY_TEST_PASS
