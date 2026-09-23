#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)
TASKS_ROOT=$(cd "$ROOT/.." && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)
TIMER="openclaw-task-production-control.timer"
SERVICE="openclaw-task-production-control.service"
NEXUS_TIMER="nexus-sync.timer"
export PATH="$HOME/.npm-global/bin${PATH:+:$PATH}"

FROM=""
TO=""
DEPLOY_RESULT=""
CONTROL_REPOSITORY=""
IMPLEMENTATION_REPOSITORY=""
CONTROL_ISSUE=""
OWNER_LOGIN=""
OWNER_ID=""
TEST_ROOT=""
APPLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) [ "$#" -ge 2 ] || { echo "--from requires SHA" >&2; exit 2; }; FROM=$2; shift 2 ;;
    --to) [ "$#" -ge 2 ] || { echo "--to requires SHA" >&2; exit 2; }; TO=$2; shift 2 ;;
    --deploy-result) [ "$#" -ge 2 ] || { echo "--deploy-result requires path" >&2; exit 2; }; DEPLOY_RESULT=$2; shift 2 ;;
    --control-repository) [ "$#" -ge 2 ] || { echo "--control-repository requires OWNER/REPO" >&2; exit 2; }; CONTROL_REPOSITORY=$2; shift 2 ;;
    --implementation-repository) [ "$#" -ge 2 ] || { echo "--implementation-repository requires OWNER/REPO" >&2; exit 2; }; IMPLEMENTATION_REPOSITORY=$2; shift 2 ;;
    --control-issue) [ "$#" -ge 2 ] || { echo "--control-issue requires number" >&2; exit 2; }; CONTROL_ISSUE=$2; shift 2 ;;
    --owner-login) [ "$#" -ge 2 ] || { echo "--owner-login requires login" >&2; exit 2; }; OWNER_LOGIN=$2; shift 2 ;;
    --owner-id) [ "$#" -ge 2 ] || { echo "--owner-id requires numeric id" >&2; exit 2; }; OWNER_ID=$2; shift 2 ;;
    --test-root) [ "$#" -ge 2 ] || { echo "--test-root requires path" >&2; exit 2; }; TEST_ROOT=$2; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "Usage: $0 [--test-root /absolute/path] --from OLD_CONTROLLER_SHA --to EXACT_IMPLEMENTATION_MAIN_SHA --deploy-result /absolute/result.json --control-repository OWNER/REPO --implementation-repository OWNER/REPO --control-issue N --owner-login LOGIN --owner-id ID --apply" >&2; exit 2 ;;
  esac
done
[[ "$FROM" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid --from SHA" >&2; exit 2; }
[[ "$TO" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid --to SHA" >&2; exit 2; }
[[ "$CONTROL_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid control repository" >&2; exit 2; }
[[ "$IMPLEMENTATION_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Invalid implementation repository" >&2; exit 2; }
[ "$CONTROL_REPOSITORY" != "$IMPLEMENTATION_REPOSITORY" ] || { echo "Control and implementation repositories must be distinct" >&2; exit 2; }
[[ "$CONTROL_ISSUE" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid control issue" >&2; exit 2; }
[[ "$OWNER_LOGIN" =~ ^[A-Za-z0-9-]+$ ]] || { echo "Invalid owner login" >&2; exit 2; }
[[ "$OWNER_ID" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid owner id" >&2; exit 2; }
REPO_URL="https://github.com/${IMPLEMENTATION_REPOSITORY}.git"
case "$DEPLOY_RESULT" in /*) ;; *) echo "--deploy-result must be absolute" >&2; exit 2;; esac
[ "$APPLY" -eq 1 ] || { echo "--apply is required" >&2; exit 2; }

for cmd in awk bash cat chmod cp date flock git id install mkdir mv node realpath rm stat systemctl tr; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Required command unavailable: $cmd" >&2; exit 2; }
done
[ -n "$REPO_ROOT" ] || { echo "Authoritative checkout unavailable" >&2; exit 2; }
[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$TO" ] || { echo "Checkout HEAD does not equal --to" >&2; exit 2; }
[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ] || { echo "Refusing dirty checkout" >&2; exit 2; }

if [ -n "$TEST_ROOT" ]; then
  case "$TEST_ROOT" in /*) ;; *) echo "--test-root must be absolute" >&2; exit 2;; esac
  mkdir -p "$TEST_ROOT"
  TEST_ROOT=$(realpath -e "$TEST_ROOT")
  case "$TEST_ROOT" in /|/home/dubrovin|/home/dubrovin/*) echo "Refusing unsafe test root: $TEST_ROOT" >&2; exit 2;; esac
  STATE_DIR="$TEST_ROOT/state"
  LIB_DIR="$TEST_ROOT/lib"
  SYSTEMD_DIR="$TEST_ROOT/systemd"
  SOURCE_DIR="$TEST_ROOT/source"
  export OPC_STATE_DIR="$STATE_DIR" OPC_LIB_DIR="$LIB_DIR" OPC_SYSTEMD_DIR="$SYSTEMD_DIR"
else
  for name in OPC_STATE_DIR OPC_LIB_DIR OPC_SYSTEMD_DIR OPC_CONTROLLER_STATE OPC_SOURCE_DIR; do
    [ -z "${!name:-}" ] || { echo "$name is test-only or internally managed for break-glass reconciliation" >&2; exit 2; }
  done
  [ "$HOME" = "/home/dubrovin" ] || { echo "Unexpected HOME: $HOME" >&2; exit 2; }
  STATE_DIR="$HOME/.local/state/openclaw-production-control"
  LIB_DIR="$HOME/.local/lib/openclaw-production-control"
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  SOURCE_DIR="$HOME/.local/share/openclaw-production-control/openclaw-agents"
fi

STATE_FILE="$STATE_DIR/state.json"
CONTROLLER_LOCK="$STATE_DIR/controller.lock"
RECONCILE_LOCK="$STATE_DIR/break-glass-reconcile.lock"

[ -d "$STATE_DIR" ] || { echo "Controller state directory missing" >&2; exit 2; }
[ -f "$STATE_FILE" ] || { echo "Controller state missing" >&2; exit 2; }
[ -f "$LIB_DIR/installed-revision" ] || { echo "Installed controller revision evidence missing" >&2; exit 2; }
[ "$(tr -d '\r\n' < "$LIB_DIR/installed-revision")" = "$FROM" ] || { echo "Installed controller revision does not match --from" >&2; exit 2; }
[ -f "$SYSTEMD_DIR/$TIMER" ] || { echo "Controller timer unit missing" >&2; exit 2; }
[ -f "$SYSTEMD_DIR/$SERVICE" ] || { echo "Controller service unit missing" >&2; exit 2; }

exec 9>"$RECONCILE_LOCK"
flock -n 9 || { echo "Another break-glass reconciliation is already running" >&2; exit 2; }
[ ! -e "$CONTROLLER_LOCK" ] || { echo "Controller lock is present" >&2; exit 2; }
if systemctl --user is-active --quiet "$TIMER"; then echo "Controller timer must be inactive" >&2; exit 2; fi
if systemctl --user is-active --quiet "$SERVICE"; then echo "Controller service must be inactive" >&2; exit 2; fi
systemctl --user is-active --quiet "$NEXUS_TIMER" || { echo "Nexus sync timer must be active before controller reconciliation" >&2; exit 2; }

readarray -t PRIOR_PROVENANCE < <(node - "$STATE_FILE" "$FROM" <<'NODE'
const fs=require('fs');
const s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const from=process.argv[3];
if(s.version!==1||s.mode!=='ACTIVE'||s.controller_revision!==from||s.deployment_blocked===true)process.exit(2);
if(typeof s.production_baseline_sha!=='string'||!/^[0-9a-f]{40}$/.test(s.production_baseline_sha))process.exit(2);
const protectedBaseline=Object.hasOwn(s,'protected_path_baseline_sha')?s.protected_path_baseline_sha:s.controller_revision;
if(typeof protectedBaseline!=='string'||!/^[0-9a-f]{40}$/.test(protectedBaseline))process.exit(2);
if(Object.values(s.requests||{}).some(r=>['STARTING','IN_PROGRESS'].includes(r?.state)||r?.report_pending))process.exit(2);
if(!Number.isSafeInteger(Number(s.watermark))||!Number.isSafeInteger(Number(s.minimum_comment_id)))process.exit(2);
process.stdout.write(`${s.production_baseline_sha}\n${protectedBaseline}\n`);
NODE
) || { echo "Controller state is not eligible for break-glass reconciliation" >&2; exit 2; }
[ "${#PRIOR_PROVENANCE[@]}" -eq 2 ] || { echo "Controller provenance state is incomplete" >&2; exit 2; }
PRIOR_BASELINE=${PRIOR_PROVENANCE[0]}
PRIOR_PROTECTED_BASELINE=${PRIOR_PROVENANCE[1]}

DEPLOY_RESULT=$(realpath -e "$DEPLOY_RESULT")
[ -f "$DEPLOY_RESULT" ] && [ ! -L "$DEPLOY_RESULT" ] || { echo "Task deploy result must be a real file" >&2; exit 2; }
if [ -z "$TEST_ROOT" ]; then
  case "$DEPLOY_RESULT" in
    "$HOME/.openclaw/workspace/deliverables/"*) ;;
    *) echo "Task deploy result is outside the registered deliverables directory" >&2; exit 2 ;;
  esac
  [ "$(stat -c '%u' "$DEPLOY_RESULT")" = "$(id -u)" ] || { echo "Task deploy result owner mismatch" >&2; exit 2; }
  [ "$(stat -c '%a' "$DEPLOY_RESULT")" = "600" ] || { echo "Task deploy result must be mode 600" >&2; exit 2; }
fi
DEPLOY_STAGE=$(node - "$DEPLOY_RESULT" "$TO" <<'NODE'
const fs=require('fs');
const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const to=process.argv[3];
const noop=r.result==='PASS'&&r.stage==='NOOP'&&r.mutation_started===false;
const complete=r.result==='PASS'&&r.stage==='COMPLETE'&&r.mutation_started===true;
if((!noop&&!complete)||r.source_revision!==to)process.exit(2);
process.stdout.write(r.stage);
NODE
) || { echo "Task deploy result does not prove the exact target runtime" >&2; exit 2; }

preflight=$("$TASKS_ROOT/deploy.sh" --preflight) || { echo "Task Agent target preflight failed" >&2; exit 2; }
PREFLIGHT_PASS=$(awk '/^TASK_AGENT_DEPLOY_PREFLIGHT_PASS /{print; exit}' <<<"$preflight")
[ -n "$PREFLIGHT_PASS" ] || { echo "Unexpected Task Agent preflight output" >&2; exit 2; }
START_IS_TARGET=$(awk '{for(i=1;i<=NF;i++)if($i~/^start_is_target=/){sub(/^start_is_target=/,"",$i);print $i;exit}}' <<<"$PREFLIGHT_PASS")
[ "$START_IS_TARGET" = "1" ] || { echo "Task runtime is not the exact target generation" >&2; exit 2; }

MUTATED=0
BACKUP_READY=0
TIMER_STARTED=0
SOURCE_EXISTED=0
BACKUP=""
recover_on_error(){
  local code=$? recovery_failed=0
  trap - ERR INT TERM
  set +e
  if [ "$TIMER_STARTED" -eq 1 ]; then
    systemctl --user stop "$TIMER" >/dev/null 2>&1 || recovery_failed=1
  fi
  if [ "$MUTATED" -eq 1 ]; then
    if [ "$BACKUP_READY" -ne 1 ]; then
      recovery_failed=1
    else
      rm -rf "$LIB_DIR" || recovery_failed=1
      cp -a "$BACKUP/lib.before" "$LIB_DIR" || recovery_failed=1
      install -m 600 "$BACKUP/state.json.before" "$STATE_FILE" || recovery_failed=1
      install -m 644 "$BACKUP/$SERVICE.before" "$SYSTEMD_DIR/$SERVICE" || recovery_failed=1
      install -m 644 "$BACKUP/$TIMER.before" "$SYSTEMD_DIR/$TIMER" || recovery_failed=1
      rm -rf "$SOURCE_DIR" || recovery_failed=1
      if [ "$SOURCE_EXISTED" -eq 1 ]; then
        cp -a "$BACKUP/source.before" "$SOURCE_DIR" || recovery_failed=1
      fi
      systemctl --user daemon-reload >/dev/null 2>&1 || recovery_failed=1
    fi
  fi
  if systemctl --user is-active --quiet "$TIMER"; then recovery_failed=1; fi
  if [ "$recovery_failed" -ne 0 ]; then
    echo "CONTROLLER_BREAK_GLASS_RECONCILIATION_RECOVERY_INCOMPLETE" >&2
    exit 3
  fi
  exit "$code"
}
trap recover_on_error ERR INT TERM

STAMP=$(date -u +%Y%m%dT%H%M%SZ)-$$
BACKUP="$STATE_DIR/break-glass-reconcile-$STAMP"
mkdir -m 700 "$BACKUP"
cp -a "$LIB_DIR" "$BACKUP/lib.before"
install -m 600 "$STATE_FILE" "$BACKUP/state.json.before"
install -m 600 "$SYSTEMD_DIR/$SERVICE" "$BACKUP/$SERVICE.before"
install -m 600 "$SYSTEMD_DIR/$TIMER" "$BACKUP/$TIMER.before"
if [ -e "$SOURCE_DIR" ]; then
  [ -d "$SOURCE_DIR/.git" ] && [ ! -L "$SOURCE_DIR" ] || { echo "Existing controller source checkout is not a normal git repository" >&2; false; }
  cp -a "$SOURCE_DIR" "$BACKUP/source.before"
  SOURCE_EXISTED=1
fi
TARGET_SOURCE="$BACKUP/source.target"
git clone --quiet --no-hardlinks --no-checkout "$REPO_ROOT" "$TARGET_SOURCE"
git -C "$TARGET_SOURCE" checkout --quiet --detach "$TO"
git -C "$TARGET_SOURCE" clean -fdx >/dev/null
git -C "$TARGET_SOURCE" remote set-url origin "$REPO_URL"
chmod 700 "$TARGET_SOURCE"
[ "$(git -C "$TARGET_SOURCE" rev-parse HEAD)" = "$TO" ] || { echo "Prepared controller source checkout revision mismatch" >&2; false; }
[ -z "$(git -C "$TARGET_SOURCE" status --porcelain --untracked-files=all)" ] || { echo "Prepared controller source checkout is dirty" >&2; false; }
[ "$(git -C "$TARGET_SOURCE" remote get-url origin)" = "$REPO_URL" ] || { echo "Prepared controller source origin mismatch" >&2; false; }
BACKUP_READY=1

MUTATED=1
rm -rf "$SOURCE_DIR"
mkdir -p "$(dirname "$SOURCE_DIR")"
mv "$TARGET_SOURCE" "$SOURCE_DIR"
[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$TO" ] || { echo "Controller source checkout did not advance to target" >&2; false; }
[ -z "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=all)" ] || { echo "Installed controller source checkout is dirty" >&2; false; }
[ "$(git -C "$SOURCE_DIR" remote get-url origin)" = "$REPO_URL" ] || { echo "Installed controller source origin mismatch" >&2; false; }

bash "$ROOT/install.sh" --apply >/dev/null
[ "$(tr -d '\r\n' < "$LIB_DIR/installed-revision")" = "$TO" ] || { echo "Installed controller revision did not advance to target" >&2; false; }

CANDIDATE_STATE="$BACKUP/state.candidate.json"
node - "$STATE_FILE" "$CANDIDATE_STATE" "$FROM" "$TO" "$PRIOR_BASELINE" "$PRIOR_PROTECTED_BASELINE" "$CONTROL_REPOSITORY" "$IMPLEMENTATION_REPOSITORY" "$CONTROL_ISSUE" "$OWNER_LOGIN" "$OWNER_ID" <<'NODE'
const fs=require('fs');
const p=process.argv[2],out=process.argv[3],from=process.argv[4],to=process.argv[5],baseline=process.argv[6],protectedBaseline=process.argv[7];
const controlRepository=process.argv[8],implementationRepository=process.argv[9],controlIssue=Number(process.argv[10]),ownerLogin=process.argv[11],ownerId=Number(process.argv[12]);
const s=JSON.parse(fs.readFileSync(p,'utf8'));
if(s.version!==1||s.mode!=='ACTIVE'||s.controller_revision!==from||s.deployment_blocked===true||s.production_baseline_sha!==baseline||(Object.hasOwn(s,'protected_path_baseline_sha')?s.protected_path_baseline_sha:s.controller_revision)!==protectedBaseline)process.exit(2);
if(Object.values(s.requests||{}).some(r=>['STARTING','IN_PROGRESS'].includes(r?.state)||r?.report_pending))process.exit(2);
Object.assign(s,{control_repository:controlRepository,implementation_repository:implementationRepository,control_issue:controlIssue,owner_login:ownerLogin,owner_id:ownerId,controller_revision:to,protected_path_baseline_sha:to,production_baseline_sha:to});
fs.writeFileSync(out,JSON.stringify(s,null,2)+'\n',{mode:0o600});
fs.chmodSync(out,0o600);
NODE

diag=$(OPC_CONTROLLER_STATE="$CANDIDATE_STATE" OPC_SOURCE_DIR="$SOURCE_DIR" "$LIB_DIR/controller.mjs" diagnose-local)
node -e 'const d=JSON.parse(process.argv[1]);if(d.ok!==true)process.exit(2)' "$diag" || { echo "Target controller local diagnostics failed" >&2; false; }

node - "$STATE_FILE" "$FROM" "$TO" "$PRIOR_BASELINE" "$PRIOR_PROTECTED_BASELINE" "$DEPLOY_STAGE" "$CONTROL_REPOSITORY" "$IMPLEMENTATION_REPOSITORY" "$CONTROL_ISSUE" "$OWNER_LOGIN" "$OWNER_ID" <<'NODE'
const fs=require('fs');
const p=process.argv[2],from=process.argv[3],to=process.argv[4],baseline=process.argv[5],protectedBaseline=process.argv[6],deployStage=process.argv[7];
const controlRepository=process.argv[8],implementationRepository=process.argv[9],controlIssue=Number(process.argv[10]),ownerLogin=process.argv[11],ownerId=Number(process.argv[12]);
const s=JSON.parse(fs.readFileSync(p,'utf8'));
if(s.version!==1||s.mode!=='ACTIVE'||s.controller_revision!==from||s.deployment_blocked===true||s.production_baseline_sha!==baseline||(Object.hasOwn(s,'protected_path_baseline_sha')?s.protected_path_baseline_sha:s.controller_revision)!==protectedBaseline)process.exit(2);
if(Object.values(s.requests||{}).some(r=>['STARTING','IN_PROGRESS'].includes(r?.state)||r?.report_pending))process.exit(2);
Object.assign(s,{control_repository:controlRepository,implementation_repository:implementationRepository,control_issue:controlIssue,owner_login:ownerLogin,owner_id:ownerId,controller_revision:to,protected_path_baseline_sha:to,production_baseline_sha:to});
s.last_diagnostic=null;
s.last_break_glass_reconciliation={from_controller:from,from_protected_path_baseline:protectedBaseline,from_production_baseline:baseline,deploy_stage:deployStage,to,reconciled_at:new Date().toISOString()};
const tmp=`${p}.tmp.${process.pid}`;
fs.writeFileSync(tmp,JSON.stringify(s,null,2)+'\n',{mode:0o600});
fs.renameSync(tmp,p);
fs.chmodSync(p,0o600);
NODE

node - "$STATE_FILE" "$TO" "$CONTROL_REPOSITORY" "$IMPLEMENTATION_REPOSITORY" <<'NODE' || { echo "Reconciled controller state validation failed" >&2; false; }
const fs=require('fs'),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),to=process.argv[3],control=process.argv[4],implementation=process.argv[5];
if(s.version!==1||s.mode!=='ACTIVE'||s.controller_revision!==to||s.protected_path_baseline_sha!==to||s.production_baseline_sha!==to||s.deployment_blocked===true)process.exit(2);
if(s.control_repository!==control||s.implementation_repository!==implementation||control===implementation)process.exit(2);
if(Object.values(s.requests||{}).some(r=>['STARTING','IN_PROGRESS'].includes(r?.state)||r?.report_pending))process.exit(2);
NODE
[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$TO" ] || { echo "Reconciled controller source validation failed" >&2; false; }

systemctl --user start "$TIMER"
TIMER_STARTED=1
systemctl --user is-active --quiet "$TIMER" || { echo "Controller timer did not become active" >&2; false; }

cat > "$BACKUP/result.json" <<JSON
{"result":"PASS","mode":"ACTIVE","from_controller":"$FROM","from_protected_path_baseline":"$PRIOR_PROTECTED_BASELINE","to_protected_path_baseline":"$TO","from_production_baseline":"$PRIOR_BASELINE","deploy_stage":"$DEPLOY_STAGE","to":"$TO","task_deploy_result":"$DEPLOY_RESULT","backup":"$BACKUP","completed_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
chmod 600 "$BACKUP/result.json"

TIMER_STARTED=0
MUTATED=0
trap - ERR INT TERM
printf 'TASK_PRODUCTION_CONTROL_BREAK_GLASS_RECONCILIATION_PASS\n'
printf 'RESULT_FILE=%s\n' "$BACKUP/result.json"
