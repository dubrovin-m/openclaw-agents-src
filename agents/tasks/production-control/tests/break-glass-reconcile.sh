#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/task-production-control-break-glass-reconcile.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
REPO="$TMP/repo"
TASKS="$REPO/agents/tasks"
PC="$TASKS/production-control"
CONTROL_REPOSITORY='example/control'
IMPLEMENTATION_REPOSITORY='example/source'
IMPLEMENTATION_URL="https://github.com/${IMPLEMENTATION_REPOSITORY}.git"
CONTROL_ISSUE=7
OWNER_LOGIN='owner'
OWNER_ID=123
mkdir -p "$PC"

cat > "$TASKS/deploy.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "--preflight" ] || exit 2
echo 'EXECUTION_ID=task-agent-deploy-test'
if [ "${PREFLIGHT_TARGET:-1}" = "1" ]; then
  echo 'TASK_AGENT_DEPLOY_PREFLIGHT_PASS start_is_target=1 target_taskctl=0.4.1 current_taskctl=0.4.1 target_plugin=0.4.6 current_plugin=0.4.6'
else
  echo 'TASK_AGENT_DEPLOY_PREFLIGHT_PASS start_is_target=0 target_taskctl=0.4.1 current_taskctl=0.4.1 target_plugin=0.4.6 current_plugin=0.4.6'
fi
SH
chmod 755 "$TASKS/deploy.sh"

cat > "$PC/controller.mjs" <<'JS'
#!/usr/bin/env node
if(process.argv[2]==='diagnose-local') process.stdout.write('{"ok":true,"generation":"old"}\n');
else process.exit(2);
JS
chmod 755 "$PC/controller.mjs"
printf 'export const generation="old";\n' > "$PC/lib.mjs"
printf 'export const generation="old";\n' > "$PC/diagnose.mjs"
cat > "$PC/install.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "--apply" ] || exit 2
root=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$root" rev-parse --show-toplevel)
rev=$(git -C "$repo" rev-parse HEAD)
mkdir -p "$OPC_LIB_DIR" "$OPC_SYSTEMD_DIR"
install -m 700 "$root/controller.mjs" "$OPC_LIB_DIR/controller.mjs"
install -m 600 "$root/lib.mjs" "$OPC_LIB_DIR/lib.mjs"
install -m 700 "$root/diagnose.mjs" "$OPC_LIB_DIR/diagnose.mjs"
printf '%s\n' "$rev" > "$OPC_LIB_DIR/installed-revision"
chmod 600 "$OPC_LIB_DIR/installed-revision"
install -m 644 "$root/openclaw-task-production-control.service" "$OPC_SYSTEMD_DIR/openclaw-task-production-control.service"
install -m 644 "$root/openclaw-task-production-control.timer" "$OPC_SYSTEMD_DIR/openclaw-task-production-control.timer"
systemctl --user daemon-reload
SH
chmod 755 "$PC/install.sh"
printf '[Unit]\nDescription=test service\n' > "$PC/openclaw-task-production-control.service"
printf '[Timer]\nOnUnitActiveSec=1m\n' > "$PC/openclaw-task-production-control.timer"

cd "$REPO"
git init -q
git config user.email test@example.com
git config user.name test
git add .
git commit -qm controller-from
FROM=$(git rev-parse HEAD)
BASELINE=$FROM

printf 'steady-state-source-change\n' > "$TASKS/runtime-marker"
cp "$ROOT/reconcile-break-glass.sh" "$PC/reconcile-break-glass.sh"
chmod 755 "$PC/reconcile-break-glass.sh"
cat > "$PC/controller.mjs" <<'JS'
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if(process.argv[2]!=='diagnose-local') process.exit(2);
let ok=false;
try {
  if(process.env.FAIL_DIAG==='1') throw new Error('synthetic diagnostic failure');
  const candidatePath=process.env.OPC_CONTROLLER_STATE;
  const sourceDir=process.env.OPC_SOURCE_DIR;
  const persistentPath=path.join(process.env.OPC_STATE_DIR,'state.json');
  if(!candidatePath||!sourceDir||candidatePath===persistentPath) throw new Error('candidate inputs missing');
  const candidate=JSON.parse(fs.readFileSync(candidatePath,'utf8'));
  const here=path.dirname(fileURLToPath(import.meta.url));
  const installed=fs.readFileSync(path.join(here,'installed-revision'),'utf8').trim();
  const source=execFileSync('git',['-C',sourceDir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  ok=candidate.controller_revision===installed&&candidate.protected_path_baseline_sha===source&&candidate.production_baseline_sha===source&&candidate.control_repository==='example/control'&&candidate.implementation_repository==='example/source';
} catch {}
process.stdout.write(JSON.stringify({ok,generation:'target'})+'\n');
JS
chmod 755 "$PC/controller.mjs"
printf 'export const generation="target";\n' > "$PC/lib.mjs"
printf 'export const generation="target";\n' > "$PC/diagnose.mjs"
git add .
git commit -qm break-glass-target
TO=$(git rev-parse HEAD)

RUNTIME="$TMP/runtime"
STATE="$RUNTIME/state"
LIB="$RUNTIME/lib"
SYSTEMD="$RUNTIME/systemd"
SOURCE="$RUNTIME/source"
DELIVERABLES="$TMP/deliverables"
SYSTEMCTL_STATE="$TMP/systemctl-state"
mkdir -p "$TMP/shims" "$DELIVERABLES" "$SYSTEMCTL_STATE"

cat > "$TMP/shims/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
state=${TEST_SYSTEMCTL_STATE:?}
[ "${1:-}" = "--user" ] && shift
case "$1" in
  start)
    [ "$2" = "openclaw-task-production-control.timer" ] || exit 2
    [ ! -f "$state/fail-start" ] || exit 1
    echo active > "$state/timer"
    echo start >> "$state/calls"
    ;;
  stop)
    [ "$2" = "openclaw-task-production-control.timer" ] || exit 2
    echo inactive > "$state/timer"
    echo stop >> "$state/calls"
    ;;
  is-active)
    if [ "${2:-}" = "--quiet" ]; then unit=$3; else unit=$2; fi
    case "$unit" in
      openclaw-task-production-control.timer) [ "$(cat "$state/timer")" = active ] ;;
      openclaw-task-production-control.service) [ "$(cat "$state/service")" = active ] ;;
      nexus-sync.timer) [ "$(cat "$state/nexus")" = active ] ;;
      *) exit 2 ;;
    esac
    ;;
  daemon-reload) echo reload >> "$state/calls" ;;
  *) exit 2 ;;
esac
SH
chmod 755 "$TMP/shims/systemctl"

NODE_DIR=$(dirname "$(command -v node)")
export HOME="$TMP/home"
mkdir -p "$HOME/.npm-global/bin"
export PATH="$TMP/shims:$NODE_DIR:/usr/bin:/bin"
export TEST_SYSTEMCTL_STATE="$SYSTEMCTL_STATE"

write_deploy_result(){
  local stage=${1:-NOOP} mutation=${2:-false} source=${3:-$TO}
  cat > "$DELIVERABLES/task-result.json" <<JSON
{"result":"PASS","stage":"$stage","source_revision":"$source","mutation_started":$mutation}
JSON
  chmod 600 "$DELIVERABLES/task-result.json"
}

reset_runtime(){
  rm -rf "$RUNTIME"
  mkdir -p "$STATE" "$LIB" "$SYSTEMD"
  printf '%s\n' "$FROM" > "$LIB/installed-revision"
  git show "$FROM:agents/tasks/production-control/controller.mjs" > "$LIB/controller.mjs"
  git show "$FROM:agents/tasks/production-control/lib.mjs" > "$LIB/lib.mjs"
  git show "$FROM:agents/tasks/production-control/diagnose.mjs" > "$LIB/diagnose.mjs"
  chmod 700 "$LIB/controller.mjs" "$LIB/diagnose.mjs"
  chmod 600 "$LIB/lib.mjs" "$LIB/installed-revision"
  git show "$FROM:agents/tasks/production-control/openclaw-task-production-control.service" > "$SYSTEMD/openclaw-task-production-control.service"
  git show "$FROM:agents/tasks/production-control/openclaw-task-production-control.timer" > "$SYSTEMD/openclaw-task-production-control.timer"
  chmod 644 "$SYSTEMD"/*
  cat > "$STATE/state.json" <<JSON
{"version":1,"mode":"ACTIVE","controller_revision":"$FROM","protected_path_baseline_sha":"$FROM","production_baseline_sha":"$BASELINE","deployment_blocked":false,"last_diagnostic":{"ok":true},"requests":{"77":{"type":"diagnose","state":"SUCCESS","completed_at":"old"}},"watermark":100,"minimum_comment_id":50}
JSON
  chmod 600 "$STATE/state.json"
  git clone -q --no-hardlinks --no-checkout "$REPO" "$SOURCE"
  git -C "$SOURCE" checkout -q --detach "$FROM"
  git -C "$SOURCE" remote set-url origin "$IMPLEMENTATION_URL"
  chmod 700 "$SOURCE"
  echo inactive > "$SYSTEMCTL_STATE/timer"
  echo inactive > "$SYSTEMCTL_STATE/service"
  echo active > "$SYSTEMCTL_STATE/nexus"
  rm -f "$SYSTEMCTL_STATE/fail-start"
  : > "$SYSTEMCTL_STATE/calls"
  write_deploy_result
}

run_reconcile(){
  "$PC/reconcile-break-glass.sh" --test-root "$RUNTIME" --from "$FROM" --to "$TO" --deploy-result "$DELIVERABLES/task-result.json" \
    --control-repository "$CONTROL_REPOSITORY" --implementation-repository "$IMPLEMENTATION_REPOSITORY" \
    --control-issue "$CONTROL_ISSUE" --owner-login "$OWNER_LOGIN" --owner-id "$OWNER_ID" --apply
}

assert_old_state(){
  test "$(cat "$LIB/installed-revision")" = "$FROM"
  node - "$STATE/state.json" "$FROM" "$BASELINE" <<'NODE'
const fs=require('fs'),s=JSON.parse(fs.readFileSync(process.argv[2])),from=process.argv[3],baseline=process.argv[4];
if(s.mode!=='ACTIVE'||s.controller_revision!==from||s.protected_path_baseline_sha!==from||s.production_baseline_sha!==baseline||s.watermark!==100||s.minimum_comment_id!==50)process.exit(2);
if(s.requests?.['77']?.state!=='SUCCESS'||s.last_diagnostic?.ok!==true)process.exit(2);
NODE
  test "$(git -C "$SOURCE" rev-parse HEAD)" = "$FROM"
  test "$(git -C "$SOURCE" remote get-url origin)" = "$IMPLEMENTATION_URL"
  test "$(cat "$SYSTEMCTL_STATE/timer")" = inactive
}

assert_target_state(){
  local stage=$1
  test "$(cat "$LIB/installed-revision")" = "$TO"
  node - "$STATE/state.json" "$TO" "$FROM" "$stage" "$CONTROL_REPOSITORY" "$IMPLEMENTATION_REPOSITORY" "$CONTROL_ISSUE" "$OWNER_LOGIN" "$OWNER_ID" <<'NODE'
const fs=require('fs'),s=JSON.parse(fs.readFileSync(process.argv[2])),to=process.argv[3],from=process.argv[4],stage=process.argv[5];
const control=process.argv[6],implementation=process.argv[7],issue=Number(process.argv[8]),login=process.argv[9],ownerId=Number(process.argv[10]);
if(s.mode!=='ACTIVE'||s.controller_revision!==to||s.protected_path_baseline_sha!==to||s.production_baseline_sha!==to||s.last_diagnostic!==null)process.exit(2);
if(s.control_repository!==control||s.implementation_repository!==implementation||s.control_issue!==issue||s.owner_login!==login||s.owner_id!==ownerId)process.exit(2);
if(s.watermark!==100||s.minimum_comment_id!==50||s.requests?.['77']?.state!=='SUCCESS')process.exit(2);
if(s.last_break_glass_reconciliation?.from_controller!==from||s.last_break_glass_reconciliation?.from_protected_path_baseline!==from||s.last_break_glass_reconciliation?.deploy_stage!==stage||s.last_break_glass_reconciliation?.to!==to)process.exit(2);
NODE
  test "$(git -C "$SOURCE" rev-parse HEAD)" = "$TO"
  test -z "$(git -C "$SOURCE" status --porcelain --untracked-files=all)"
  test "$(git -C "$SOURCE" remote get-url origin)" = "$IMPLEMENTATION_URL"
  test "$(cat "$SYSTEMCTL_STATE/timer")" = active
  result_file=$(find "$STATE" -path '*/break-glass-reconcile-*/result.json' -print -quit)
  test -n "$result_file"
  node - "$result_file" "$FROM" "$TO" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2])),from=process.argv[3],to=process.argv[4];
if(r.result!=='PASS'||r.from_protected_path_baseline!==from||r.to_protected_path_baseline!==to)process.exit(2);
NODE
}

cd "$REPO"

echo STAGE=noop-success
reset_runtime
write_deploy_result NOOP false "$TO"
run_reconcile >/dev/null
assert_target_state NOOP

echo STAGE=complete-success
reset_runtime
write_deploy_result COMPLETE true "$TO"
run_reconcile >/dev/null
assert_target_state COMPLETE

echo STAGE=wrong-source
reset_runtime
write_deploy_result NOOP false "$FROM"
set +e
run_reconcile >/dev/null 2>&1
code=$?
set -e
test "$code" -eq 2
assert_old_state

echo STAGE=invalid-result-pair
reset_runtime
write_deploy_result COMPLETE false "$TO"
set +e
run_reconcile >/dev/null 2>&1
code=$?
set -e
test "$code" -eq 2
assert_old_state

echo STAGE=preflight-not-target
reset_runtime
set +e
PREFLIGHT_TARGET=0 run_reconcile >/dev/null 2>&1
code=$?
set -e
test "$code" -eq 2
assert_old_state

echo STAGE=active-timer
reset_runtime
echo active > "$SYSTEMCTL_STATE/timer"
set +e
run_reconcile >/dev/null 2>&1
code=$?
set -e
test "$code" -eq 2
echo inactive > "$SYSTEMCTL_STATE/timer"
assert_old_state

echo STAGE=diagnostic-rollback
reset_runtime
set +e
FAIL_DIAG=1 run_reconcile >/dev/null 2>&1
code=$?
set -e
test "$code" -ne 0
assert_old_state

echo STAGE=timer-start-rollback
reset_runtime
touch "$SYSTEMCTL_STATE/fail-start"
set +e
run_reconcile >/dev/null 2>&1
code=$?
set -e
test "$code" -ne 0
rm -f "$SYSTEMCTL_STATE/fail-start"
assert_old_state

echo TASK_PRODUCTION_CONTROL_BREAK_GLASS_RECONCILIATION_TEST_PASS
