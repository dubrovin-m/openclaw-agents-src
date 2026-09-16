#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)
TIMER="openclaw-task-production-control.timer"
SERVICE="openclaw-task-production-control.service"
NEXUS_TIMER="nexus-sync.timer"
IMPLEMENTATION_REPOSITORY="${OPC_IMPLEMENTATION_REPOSITORY:-}"
export PATH="$HOME/.npm-global/bin${PATH:+:$PATH}"

RUNNER_REVISION=""
CONTROLLER_REVISION=""
FROM_BASELINE=""
TO_BASELINE=""
TARGET_SOURCE_INPUT=""
DEPLOY_RESULT=""
TEST_ROOT=""
APPLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runner) [ "$#" -ge 2 ] || { echo "--runner requires SHA" >&2; exit 2; }; RUNNER_REVISION=$2; shift 2 ;;
    --controller) [ "$#" -ge 2 ] || { echo "--controller requires SHA" >&2; exit 2; }; CONTROLLER_REVISION=$2; shift 2 ;;
    --from-baseline) [ "$#" -ge 2 ] || { echo "--from-baseline requires SHA" >&2; exit 2; }; FROM_BASELINE=$2; shift 2 ;;
    --to-baseline) [ "$#" -ge 2 ] || { echo "--to-baseline requires SHA" >&2; exit 2; }; TO_BASELINE=$2; shift 2 ;;
    --target-source) [ "$#" -ge 2 ] || { echo "--target-source requires path" >&2; exit 2; }; TARGET_SOURCE_INPUT=$2; shift 2 ;;
    --deploy-result) [ "$#" -ge 2 ] || { echo "--deploy-result requires path" >&2; exit 2; }; DEPLOY_RESULT=$2; shift 2 ;;
    --test-root) [ "$#" -ge 2 ] || { echo "--test-root requires path" >&2; exit 2; }; TEST_ROOT=$2; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "Usage: OPC_IMPLEMENTATION_REPOSITORY=OWNER/REPO $0 [--test-root /absolute/path] --runner RUNNER_SHA --controller CONTROLLER_SHA --from-baseline OLD_BASELINE_SHA --to-baseline NEW_BASELINE_SHA --target-source /absolute/clean/checkout --deploy-result /absolute/result.json --apply" >&2; exit 2 ;;
  esac
done

for value in "$RUNNER_REVISION" "$CONTROLLER_REVISION" "$FROM_BASELINE" "$TO_BASELINE"; do
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid SHA argument" >&2; exit 2; }
done
[[ "$IMPLEMENTATION_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "OPC_IMPLEMENTATION_REPOSITORY is required and must be OWNER/REPO" >&2; exit 2; }
REPO_URL="https://github.com/${IMPLEMENTATION_REPOSITORY}.git"
REPO_URL_PLAIN="https://github.com/${IMPLEMENTATION_REPOSITORY}"
[ "$FROM_BASELINE" != "$TO_BASELINE" ] || { echo "Baseline target must differ from current baseline" >&2; exit 2; }
case "$TARGET_SOURCE_INPUT" in /*) ;; *) echo "--target-source must be absolute" >&2; exit 2;; esac
case "$DEPLOY_RESULT" in /*) ;; *) echo "--deploy-result must be absolute" >&2; exit 2;; esac
[ "$APPLY" -eq 1 ] || { echo "--apply is required" >&2; exit 2; }

for cmd in awk bash cat chmod cp date dirname flock git id install mkdir mv node realpath rm stat systemctl tr; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Required command unavailable: $cmd" >&2; exit 2; }
done
[ -n "$REPO_ROOT" ] || { echo "Runner repository root unavailable" >&2; exit 2; }
[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$RUNNER_REVISION" ] || { echo "Runner checkout HEAD does not equal --runner" >&2; exit 2; }
[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ] || { echo "Refusing dirty runner checkout" >&2; exit 2; }

TARGET_SOURCE_INPUT=$(realpath -e "$TARGET_SOURCE_INPUT") || { echo "Unable to resolve target source checkout" >&2; exit 2; }
[ -d "$TARGET_SOURCE_INPUT/.git" ] && [ ! -L "$TARGET_SOURCE_INPUT" ] || { echo "Target source is not a normal git checkout" >&2; exit 2; }
[ "$(git -C "$TARGET_SOURCE_INPUT" rev-parse HEAD)" = "$TO_BASELINE" ] || { echo "Target source HEAD does not equal --to-baseline" >&2; exit 2; }
[ -z "$(git -C "$TARGET_SOURCE_INPUT" status --porcelain --untracked-files=all)" ] || { echo "Refusing dirty target source checkout" >&2; exit 2; }
TARGET_ORIGIN=$(git -C "$TARGET_SOURCE_INPUT" remote get-url origin 2>/dev/null || true)
case "$TARGET_ORIGIN" in
  "$REPO_URL_PLAIN"|"$REPO_URL") ;;
  *) echo "Target source origin is not canonical" >&2; exit 2 ;;
esac
TARGET_TASKS="$TARGET_SOURCE_INPUT/agents/tasks"
[ -f "$TARGET_TASKS/deploy.sh" ] && [ -f "$TARGET_TASKS/recover.sh" ] && [ -f "$TARGET_TASKS/release.json" ] || { echo "Target Task source is incomplete" >&2; exit 2; }

if [ -n "$TEST_ROOT" ]; then
  case "$TEST_ROOT" in /*) ;; *) echo "--test-root must be absolute" >&2; exit 2;; esac
  mkdir -p "$TEST_ROOT"
  TEST_ROOT=$(realpath -e "$TEST_ROOT")
  case "$TEST_ROOT" in /|/home/dubrovin|/home/dubrovin/*) echo "Refusing unsafe test root: $TEST_ROOT" >&2; exit 2;; esac
  STATE_DIR="$TEST_ROOT/state"
  LIB_DIR="$TEST_ROOT/lib"
  SYSTEMD_DIR="$TEST_ROOT/systemd"
  SOURCE_DIR="$TEST_ROOT/source"
  TASK_TEST_ROOT="$TEST_ROOT/task-runtime"
  mkdir -p "$TASK_TEST_ROOT"
  export OPC_STATE_DIR="$STATE_DIR" OPC_LIB_DIR="$LIB_DIR" OPC_SYSTEMD_DIR="$SYSTEMD_DIR"
else
  for name in OPC_STATE_DIR OPC_LIB_DIR OPC_SYSTEMD_DIR OPC_CONTROLLER_STATE OPC_SOURCE_DIR; do
    [ -z "${!name:-}" ] || { echo "$name is test-only or internally managed for baseline reconciliation" >&2; exit 2; }
  done
  [ "$HOME" = "/home/dubrovin" ] || { echo "Unexpected HOME: $HOME" >&2; exit 2; }
  STATE_DIR="$HOME/.local/state/openclaw-production-control"
  LIB_DIR="$HOME/.local/lib/openclaw-production-control"
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  SOURCE_DIR="$HOME/.local/share/openclaw-production-control/openclaw-agents"
  TASK_TEST_ROOT=""
fi

STATE_FILE="$STATE_DIR/state.json"
CONTROLLER_LOCK="$STATE_DIR/controller.lock"
RECONCILE_LOCK="$STATE_DIR/baseline-break-glass-reconcile.lock"

[ -d "$STATE_DIR" ] || { echo "Controller state directory missing" >&2; exit 2; }
[ -f "$STATE_FILE" ] || { echo "Controller state missing" >&2; exit 2; }
[ -f "$LIB_DIR/installed-revision" ] && [ -f "$LIB_DIR/controller.mjs" ] || { echo "Installed controller evidence missing" >&2; exit 2; }
[ "$(tr -d '\r\n' < "$LIB_DIR/installed-revision")" = "$CONTROLLER_REVISION" ] || { echo "Installed controller revision does not match --controller" >&2; exit 2; }
[ -f "$SYSTEMD_DIR/$TIMER" ] || { echo "Controller timer unit missing" >&2; exit 2; }
[ -f "$SYSTEMD_DIR/$SERVICE" ] || { echo "Controller service unit missing" >&2; exit 2; }
[ -d "$SOURCE_DIR/.git" ] && [ ! -L "$SOURCE_DIR" ] || { echo "Durable production source checkout missing" >&2; exit 2; }
[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$FROM_BASELINE" ] || { echo "Durable production source does not match --from-baseline" >&2; exit 2; }
[ -z "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=all)" ] || { echo "Durable production source checkout is dirty" >&2; exit 2; }

exec 9>"$RECONCILE_LOCK"
flock -n 9 || { echo "Another baseline reconciliation is already running" >&2; exit 2; }
[ ! -e "$CONTROLLER_LOCK" ] || { echo "Controller lock is present" >&2; exit 2; }
if systemctl --user is-active --quiet "$TIMER"; then echo "Controller timer must be inactive" >&2; exit 2; fi
if systemctl --user is-active --quiet "$SERVICE"; then echo "Controller service must be inactive" >&2; exit 2; fi
systemctl --user is-active --quiet "$NEXUS_TIMER" || { echo "Nexus sync timer must be active before baseline reconciliation" >&2; exit 2; }

node - "$STATE_FILE" "$CONTROLLER_REVISION" "$FROM_BASELINE" "$IMPLEMENTATION_REPOSITORY" <<'NODE' || { echo "Controller state is not eligible for baseline reconciliation" >&2; exit 2; }
const fs=require('fs');
const s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const controller=process.argv[3],baseline=process.argv[4],implementation=process.argv[5];
if(s.version!==1||s.mode!=='ACTIVE'||s.controller_revision!==controller||s.production_baseline_sha!==baseline||s.deployment_blocked===true||s.implementation_repository!==implementation)process.exit(2);
if(Object.values(s.requests||{}).some(r=>['STARTING','IN_PROGRESS'].includes(r?.state)||r?.report_pending))process.exit(2);
if(!Number.isSafeInteger(Number(s.watermark))||!Number.isSafeInteger(Number(s.minimum_comment_id)))process.exit(2);
NODE

DEPLOY_RESULT=$(realpath -e "$DEPLOY_RESULT") || { echo "Unable to resolve Task deploy result" >&2; exit 2; }
[ -f "$DEPLOY_RESULT" ] && [ ! -L "$DEPLOY_RESULT" ] || { echo "Task deploy result must be a real file" >&2; exit 2; }
if [ -z "$TEST_ROOT" ]; then
  case "$DEPLOY_RESULT" in
    "$HOME/.openclaw/workspace/deliverables/"*) ;;
    *) echo "Task deploy result is outside the registered deliverables directory" >&2; exit 2 ;;
  esac
  [ "$(stat -c '%u' "$DEPLOY_RESULT")" = "$(id -u)" ] || { echo "Task deploy result owner mismatch" >&2; exit 2; }
  [ "$(stat -c '%a' "$DEPLOY_RESULT")" = "600" ] || { echo "Task deploy result must be mode 600" >&2; exit 2; }
fi

DEPLOY_STAGE=$(node - "$DEPLOY_RESULT" "$TO_BASELINE" <<'NODE'
const fs=require('fs');
const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const to=process.argv[3];
const noop=r.result==='PASS'&&r.stage==='NOOP'&&r.mutation_started===false;
const complete=r.result==='PASS'&&r.stage==='COMPLETE'&&r.mutation_started===true;
if((!noop&&!complete)||r.source_revision!==to)process.exit(2);
process.stdout.write(r.stage);
NODE
) || { echo "Task deploy result does not prove the exact target baseline" >&2; exit 2; }

if [ "$DEPLOY_STAGE" = "COMPLETE" ]; then
  RECOVERY_SET=$(node - "$DEPLOY_RESULT" <<'NODE'
const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(typeof r.recovery_set!=='string'||!r.recovery_set.startsWith('/'))process.exit(2);process.stdout.write(r.recovery_set);
NODE
) || { echo "Completed Task deploy result does not identify a recovery set" >&2; exit 2; }
  RECOVERY_SET=$(realpath -e "$RECOVERY_SET") || { echo "Task recovery set is unavailable" >&2; exit 2; }
  [ -d "$RECOVERY_SET" ] && [ ! -L "$RECOVERY_SET" ] || { echo "Task recovery set must be a real directory" >&2; exit 2; }
  if [ -z "$TEST_ROOT" ]; then
    case "$RECOVERY_SET" in /home/dubrovin/.openclaw/backups/task-agent-stage-*) ;; *) echo "Task recovery set is outside the registered backup boundary" >&2; exit 2;; esac
    [ "$(stat -c '%u' "$RECOVERY_SET")" = "$(id -u)" ] || { echo "Task recovery set owner mismatch" >&2; exit 2; }
    [ "$(stat -c '%a' "$RECOVERY_SET")" = "700" ] || { echo "Task recovery set must be mode 700" >&2; exit 2; }
  fi
  inspect_code=0
  if [ -n "$TEST_ROOT" ]; then
    TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT="$TARGET_SOURCE_INPUT" "$TARGET_TASKS/recover.sh" --test-root "$TASK_TEST_ROOT" --inspect --from "$RECOVERY_SET" >/dev/null 2>&1 || inspect_code=$?
  else
    "$TARGET_TASKS/recover.sh" --inspect --from "$RECOVERY_SET" >/dev/null 2>&1 || inspect_code=$?
  fi
  [ "$inspect_code" -eq 3 ] || { echo "Task recovery set failed independent inspection" >&2; exit 2; }
fi

preflight=""
if [ -n "$TEST_ROOT" ]; then
  preflight=$(TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT="$TARGET_SOURCE_INPUT" "$TARGET_TASKS/deploy.sh" --test-root "$TASK_TEST_ROOT" --preflight) || { echo "Target Task Agent preflight failed" >&2; exit 2; }
else
  preflight=$("$TARGET_TASKS/deploy.sh" --preflight) || { echo "Target Task Agent preflight failed" >&2; exit 2; }
fi
PREFLIGHT_PASS=$(awk '/^TASK_AGENT_DEPLOY_PREFLIGHT_PASS /{print; exit}' <<<"$preflight")
[ -n "$PREFLIGHT_PASS" ] || { echo "Unexpected Task Agent preflight output" >&2; exit 2; }
START_IS_TARGET=$(awk '{for(i=1;i<=NF;i++)if($i~/^start_is_target=/){sub(/^start_is_target=/,"",$i);print $i;exit}}' <<<"$PREFLIGHT_PASS")
[ "$START_IS_TARGET" = "1" ] || { echo "Task runtime is not the exact target generation" >&2; exit 2; }

MUTATED=0
BACKUP_READY=0
TIMER_TOUCHED=0
SOURCE_EXISTED=0
BACKUP=""
recover_on_error(){
  local code=$? recovery_failed=0
  trap - ERR INT TERM
  set +e
  if [ "$TIMER_TOUCHED" -eq 1 ]; then
    systemctl --user stop "$TIMER" >/dev/null 2>&1 || recovery_failed=1
  fi
  if [ "$MUTATED" -eq 1 ]; then
    if [ "$BACKUP_READY" -ne 1 ]; then
      recovery_failed=1
    else
      install -m 600 "$BACKUP/state.json.before" "$STATE_FILE" || recovery_failed=1
      rm -rf "$SOURCE_DIR" || recovery_failed=1
      if [ "$SOURCE_EXISTED" -eq 1 ]; then
        cp -a "$BACKUP/source.before" "$SOURCE_DIR" || recovery_failed=1
      fi
    fi
  fi
  if [ "$(tr -d '\r\n' < "$LIB_DIR/installed-revision" 2>/dev/null)" != "$CONTROLLER_REVISION" ]; then recovery_failed=1; fi
  if systemctl --user is-active --quiet "$TIMER"; then recovery_failed=1; fi
  if [ "$recovery_failed" -ne 0 ]; then
    echo "TASK_PRODUCTION_BASELINE_BREAK_GLASS_RECONCILIATION_RECOVERY_INCOMPLETE" >&2
    exit 3
  fi
  exit "$code"
}
trap recover_on_error ERR INT TERM

STAMP=$(date -u +%Y%m%dT%H%M%SZ)-$$
BACKUP="$STATE_DIR/baseline-break-glass-reconcile-$STAMP"
mkdir -m 700 "$BACKUP"
install -m 600 "$STATE_FILE" "$BACKUP/state.json.before"
if [ -e "$SOURCE_DIR" ]; then
  cp -a "$SOURCE_DIR" "$BACKUP/source.before"
  SOURCE_EXISTED=1
fi
TARGET_SOURCE="$BACKUP/source.target"
git clone --quiet --no-hardlinks --no-checkout "$TARGET_SOURCE_INPUT" "$TARGET_SOURCE"
git -C "$TARGET_SOURCE" checkout --quiet --detach "$TO_BASELINE"
git -C "$TARGET_SOURCE" clean -fdx >/dev/null
git -C "$TARGET_SOURCE" remote set-url origin "$REPO_URL"
chmod 700 "$TARGET_SOURCE"
[ "$(git -C "$TARGET_SOURCE" rev-parse HEAD)" = "$TO_BASELINE" ] || { echo "Prepared baseline source revision mismatch" >&2; false; }
[ -z "$(git -C "$TARGET_SOURCE" status --porcelain --untracked-files=all)" ] || { echo "Prepared baseline source checkout is dirty" >&2; false; }
[ "$(git -C "$TARGET_SOURCE" remote get-url origin)" = "$REPO_URL" ] || { echo "Prepared baseline source origin mismatch" >&2; false; }
BACKUP_READY=1

CANDIDATE_STATE="$BACKUP/state.candidate.json"
node - "$STATE_FILE" "$CANDIDATE_STATE" "$CONTROLLER_REVISION" "$FROM_BASELINE" "$TO_BASELINE" <<'NODE'
const fs=require('fs');
const p=process.argv[2],out=process.argv[3],controller=process.argv[4],from=process.argv[5],to=process.argv[6];
const s=JSON.parse(fs.readFileSync(p,'utf8'));
if(s.version!==1||s.mode!=='ACTIVE'||s.controller_revision!==controller||s.production_baseline_sha!==from||s.deployment_blocked===true)process.exit(2);
if(Object.values(s.requests||{}).some(r=>['STARTING','IN_PROGRESS'].includes(r?.state)||r?.report_pending))process.exit(2);
s.production_baseline_sha=to;
s.last_diagnostic=null;
fs.writeFileSync(out,JSON.stringify(s,null,2)+'\n',{mode:0o600});
fs.chmodSync(out,0o600);
NODE

diag=$(OPC_CONTROLLER_STATE="$CANDIDATE_STATE" OPC_SOURCE_DIR="$TARGET_SOURCE" node "$LIB_DIR/controller.mjs" diagnose-local)
node -e 'const d=JSON.parse(process.argv[1]);if(d.ok!==true)process.exit(2)' "$diag" || { echo "Installed controller diagnostics rejected the candidate baseline state" >&2; false; }

MUTATED=1
rm -rf "$SOURCE_DIR"
mkdir -p "$(dirname "$SOURCE_DIR")"
mv "$TARGET_SOURCE" "$SOURCE_DIR"
[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$TO_BASELINE" ] || { echo "Durable production source did not advance to target baseline" >&2; false; }
[ -z "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=all)" ] || { echo "Durable production source is dirty after baseline advance" >&2; false; }
[ "$(git -C "$SOURCE_DIR" remote get-url origin)" = "$REPO_URL" ] || { echo "Durable production source origin mismatch after baseline advance" >&2; false; }

node - "$STATE_FILE" "$CONTROLLER_REVISION" "$FROM_BASELINE" "$TO_BASELINE" "$DEPLOY_STAGE" "$RUNNER_REVISION" <<'NODE'
const fs=require('fs');
const p=process.argv[2],controller=process.argv[3],from=process.argv[4],to=process.argv[5],deployStage=process.argv[6],runner=process.argv[7];
const s=JSON.parse(fs.readFileSync(p,'utf8'));
if(s.version!==1||s.mode!=='ACTIVE'||s.controller_revision!==controller||s.production_baseline_sha!==from||s.deployment_blocked===true)process.exit(2);
if(Object.values(s.requests||{}).some(r=>['STARTING','IN_PROGRESS'].includes(r?.state)||r?.report_pending))process.exit(2);
s.production_baseline_sha=to;
s.last_diagnostic=null;
s.last_break_glass_reconciliation={mode:'baseline-only',controller_revision:controller,from_production_baseline:from,to_production_baseline:to,deploy_stage:deployStage,runner_revision:runner,reconciled_at:new Date().toISOString()};
const tmp=`${p}.tmp.${process.pid}`;
fs.writeFileSync(tmp,JSON.stringify(s,null,2)+'\n',{mode:0o600});
fs.renameSync(tmp,p);
fs.chmodSync(p,0o600);
NODE

node - "$STATE_FILE" "$CONTROLLER_REVISION" "$TO_BASELINE" "$RUNNER_REVISION" <<'NODE' || { echo "Reconciled baseline state validation failed" >&2; false; }
const fs=require('fs'),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),controller=process.argv[3],to=process.argv[4],runner=process.argv[5];
if(s.version!==1||s.mode!=='ACTIVE'||s.controller_revision!==controller||s.production_baseline_sha!==to||s.deployment_blocked===true)process.exit(2);
if(Object.values(s.requests||{}).some(r=>['STARTING','IN_PROGRESS'].includes(r?.state)||r?.report_pending))process.exit(2);
if(s.last_break_glass_reconciliation?.mode!=='baseline-only'||s.last_break_glass_reconciliation?.runner_revision!==runner||s.last_break_glass_reconciliation?.to_production_baseline!==to)process.exit(2);
NODE
[ "$(tr -d '\r\n' < "$LIB_DIR/installed-revision")" = "$CONTROLLER_REVISION" ] || { echo "Controller revision changed during baseline-only reconciliation" >&2; false; }

diag=$(node "$LIB_DIR/controller.mjs" diagnose-local)
node -e 'const d=JSON.parse(process.argv[1]);if(d.ok!==true)process.exit(2)' "$diag" || { echo "Installed controller diagnostics failed after baseline reconciliation" >&2; false; }

TIMER_TOUCHED=1
systemctl --user start "$TIMER"
systemctl --user is-active --quiet "$TIMER" || { echo "Controller timer did not become active" >&2; false; }

cat > "$BACKUP/result.json" <<JSON
{"result":"PASS","mode":"baseline-only","runner_revision":"$RUNNER_REVISION","controller_revision":"$CONTROLLER_REVISION","from_production_baseline":"$FROM_BASELINE","to_production_baseline":"$TO_BASELINE","deploy_stage":"$DEPLOY_STAGE","task_deploy_result":"$DEPLOY_RESULT","backup":"$BACKUP","completed_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
chmod 600 "$BACKUP/result.json"

TIMER_TOUCHED=0
MUTATED=0
trap - ERR INT TERM
printf 'TASK_PRODUCTION_BASELINE_BREAK_GLASS_RECONCILIATION_PASS\n'
printf 'RESULT_FILE=%s\n' "$BACKUP/result.json"
