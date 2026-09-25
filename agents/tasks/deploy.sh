#!/usr/bin/env bash
set -euo pipefail
umask 077

DEPLOY_PATH="$HOME/.npm-global/bin${PATH:+:$PATH}"
export PATH="$DEPLOY_PATH"

ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)
RELEASE_FILE="$ROOT/release.json"
WORKSPACE_LAYOUT_HELPER="$ROOT/workspace-layout.mjs"
PLUGIN_REGISTRY_HELPER="$ROOT/production-control/plugin-registry-state.cjs"
TARGET_WORKSPACE_FILES=()

TEST_ROOT=""
MODE=""
if [ "$#" -eq 1 ] && { [ "$1" = "--apply" ] || [ "$1" = "--preflight" ]; }; then
  MODE=${1#--}
elif [ "$#" -eq 3 ] && [ "$1" = "--test-root" ] && { [ "$3" = "--apply" ] || [ "$3" = "--preflight" ]; }; then
  TEST_ROOT=$2
  MODE=${3#--}
else
  echo "Usage: $0 --apply|--preflight" >&2
  echo "       $0 --test-root /absolute/path --apply|--preflight" >&2
  exit 2
fi

fail_plain(){ echo "$*" >&2; exit 2; }
require_cmd(){ command -v "$1" >/dev/null 2>&1 || fail_plain "Required command unavailable: $1"; }
for c in bash node git sha256sum cmp tar realpath install mkdir rm mktemp date flock tee awk chmod stat dirname sleep; do require_cmd "$c"; done

[ -n "$REPO_ROOT" ] || fail_plain "Repository root unavailable"
RUNTIME_CONTRACT_ROOT="$REPO_ROOT"
if [ -n "$TEST_ROOT" ] && [ -n "${TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT:-}" ]; then
  case "$TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT" in /*) ;; *) fail_plain "TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT must be absolute" ;; esac
  RUNTIME_CONTRACT_ROOT=$(realpath -e "$TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT") || fail_plain "Unable to resolve test runtime contract root"
fi
RUNTIME_CONTRACT="$RUNTIME_CONTRACT_ROOT/runtime-contract.json"
CONTACTS_ROOT="$REPO_ROOT/shared/contacts"
RUNTIME_HELPER="$RUNTIME_CONTRACT_ROOT/shared/runtime-contract/runtime-contract.mjs"
if [ ! -f "$WORKSPACE_LAYOUT_HELPER" ] && [ -n "$TEST_ROOT" ]; then
  TEST_WORKSPACE_LAYOUT_HELPER="$RUNTIME_CONTRACT_ROOT/agents/tasks/workspace-layout.mjs"
  [ -f "$TEST_WORKSPACE_LAYOUT_HELPER" ] && WORKSPACE_LAYOUT_HELPER="$TEST_WORKSPACE_LAYOUT_HELPER"
fi
[ -f "$RUNTIME_CONTRACT" ] && [ -f "$RUNTIME_HELPER" ] || fail_plain "Runtime contract source missing"
[ -f "$WORKSPACE_LAYOUT_HELPER" ] || fail_plain "Task Agent workspace layout helper missing"
EXPECTED_OPENCLAW_VERSION=$(node "$RUNTIME_HELPER" openclaw-version "$RUNTIME_CONTRACT") || fail_plain "Invalid runtime contract"
node "$RUNTIME_HELPER" check-node "$RUNTIME_CONTRACT" "$(node --version)" >/dev/null || fail_plain "Unsupported Node runtime"

[ -f "$RELEASE_FILE" ] || fail_plain "Task Agent release metadata missing"
RELEASE_ENV=$(EXPECTED_OPENCLAW_VERSION="$EXPECTED_OPENCLAW_VERSION" node - "$RELEASE_FILE" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const files=['AGENTS.md','SOUL.md','USER.md','IDENTITY.md','HEARTBEAT.md'];
const bad=()=>process.exit(2);
if(r?.format!=='task-agent-release-v2')bad();
const targetTaskctl=r?.generation?.taskctl_version,targetSchema=r?.generation?.sqlite_schema;
const tuple=v=>{const m=/^(\d+)\.(\d+)\.(\d+)$/.exec(v||'');return m?m.slice(1).map(Number):null};
const exactHost=(v,range)=>tuple(v)!==null&&v===range;
if(!/^0\.4\.[0-9]+$/.test(targetTaskctl||'')||!Number.isSafeInteger(targetSchema)||targetSchema<1||!tuple(r?.generation?.openclaw_build_version)||r?.generation?.openclaw_build_version!==process.env.EXPECTED_OPENCLAW_VERSION||!exactHost(process.env.EXPECTED_OPENCLAW_VERSION,r?.generation?.openclaw_compat)||r?.generation?.typebox_version!=='1.3.15')bad();
if(r?.plugin?.name!=='openclaw-plugin-taskctl'||!/^0\.4\.[0-9]+$/.test(r?.plugin?.version||''))bad();
if(r?.plugin?.artifact!==`artifacts/openclaw-plugin-taskctl-${r.plugin.version}.tgz`||!/^[0-9a-f]{64}$/.test(r?.plugin?.sha256||''))bad();
const sc=r?.shared_contacts??null;if(sc&&(sc.release_path!=='../../shared/contacts/release.json'||!/^[0-9a-f]{64}$/.test(sc.release_sha256||'')||!/^0[.]1[.][0-9]+$/.test(sc.implementation_version||'')||!Number.isSafeInteger(sc.sqlite_schema)||sc.sqlite_schema<1||sc.predecessor_mode!=='exact'))bad();
const mat=r?.calendar_materializer??null;
if(mat!==null&&(mat?.kind!=='openclaw-command-automation-v1'||typeof mat?.declaration_key!=='string'||!mat.declaration_key.trim()||typeof mat?.name!=='string'||!mat.name.trim()||typeof mat?.cron!=='string'||!mat.cron.trim()||mat?.timezone!=='Europe/Moscow'||mat?.exact!==true||!Number.isSafeInteger(mat?.timeout_seconds)||mat.timeout_seconds<1))bad();
const rem=r?.reminder_dispatcher??null;
if(rem!==null&&(rem?.kind!=='openclaw-command-automation-v1'||typeof rem?.declaration_key!=='string'||!rem.declaration_key.trim()||typeof rem?.name!=='string'||!rem.name.trim()||typeof rem?.cron!=='string'||!rem.cron.trim()||rem?.timezone!=='Europe/Moscow'||rem?.exact!==true||JSON.stringify(rem?.command_argv_suffix)!==JSON.stringify(['reminder-internal','dispatch-send'])||!Number.isSafeInteger(rem?.timeout_seconds)||rem.timeout_seconds<1||rem?.delivery_channel!=='telegram'||rem?.delivery_account!=='tasks'||rem?.delivery_recipient_source!=='tasks-owner-allowFrom-singleton'||rem?.predecessor_mode!=='exact'))bad();
const idr=r?.important_date_dispatcher??null;
if(idr!==null&&(idr?.kind!=='openclaw-script-automation-v1'||typeof idr?.declaration_key!=='string'||!idr.declaration_key.trim()||typeof idr?.name!=='string'||!idr.name.trim()||typeof idr?.cron!=='string'||!idr.cron.trim()||idr?.timezone!=='Europe/Moscow'||idr?.exact!==true||typeof idr?.script!=='string'||!idr.script.trim()||idr?.tool!=='contact_date_reminder_dispatch'||!Number.isSafeInteger(idr?.timeout_seconds)||idr.timeout_seconds<1||!Number.isSafeInteger(idr?.tool_budget)||idr.tool_budget<1||idr?.delivery_channel!=='telegram'||idr?.delivery_account!=='default'||idr?.delivery_recipient_source!=='commands.ownerAllowFrom-singleton'||idr?.best_effort!==false||idr?.predecessor_mode!=='exact'))bad();
if(!r?.from||!Array.isArray(r.from.plugin_versions)||r.from.plugin_versions.length!==1||!r.from.plugin_versions.every(v=>/^0\.4\.[0-9]+$/.test(v)))bad();
const fromSchemas=r.from.sqlite_schemas;
if(!Array.isArray(fromSchemas)||fromSchemas.length!==1||!fromSchemas.every(v=>Number.isSafeInteger(v)&&v>=1))bad();
const fromTaskctl=r.from.taskctl_versions??[targetTaskctl];
if(!Array.isArray(fromTaskctl)||fromTaskctl.length!==1||!fromTaskctl.every(v=>/^0\.4\.[0-9]+$/.test(v)))bad();
if(!r.from.workspace_sha256||Object.keys(r.from.workspace_sha256).sort().join(',')!==files.slice().sort().join(','))bad();
if(!files.every(f=>/^[0-9a-f]{64}$/.test(r.from.workspace_sha256[f]||'')))bad();
if(!/^[0-9a-f]{64}$/.test(r.from.tools_sha256||''))bad();
const q=s=>`'${String(s).replace(/'/g,"'\\''")}'`;
console.log(`TARGET_TASKCTL_VERSION=${q(targetTaskctl)}`);
console.log(`TARGET_SQLITE_SCHEMA=${q(targetSchema)}`);
console.log(`FROM_SQLITE_SCHEMAS=${q(fromSchemas.join(' '))}`);
console.log(`FROM_TASKCTL_VERSIONS=${q(fromTaskctl.join(' '))}`);
console.log(`TARGET_PLUGIN_VERSION=${q(r.plugin.version)}`);
console.log(`CONTACTS_ENABLED=${q(sc?'1':'0')}`);
console.log(`TARGET_CONTACTS_VERSION=${q(sc?.implementation_version||'')}`);
console.log(`TARGET_CONTACTS_SCHEMA=${q(sc?.sqlite_schema||'')}`);
console.log(`CONTACTS_RELEASE_REL=${q(sc?.release_path||'')}`);
console.log(`EXPECTED_CONTACTS_RELEASE_SHA=${q(sc?.release_sha256||'')}`);
console.log(`ARTIFACT_REL=${q(r.plugin.artifact)}`);
console.log(`EXPECTED_ARTIFACT_SHA=${q(r.plugin.sha256)}`);
console.log(`MATERIALIZER_ENABLED=${q(mat?'1':'0')}`);
console.log(`MATERIALIZER_DECLARATION=${q(mat?.declaration_key||'')}`);
console.log(`MATERIALIZER_NAME=${q(mat?.name||'')}`);
console.log(`MATERIALIZER_CRON=${q(mat?.cron||'')}`);
console.log(`MATERIALIZER_TIMEZONE=${q(mat?.timezone||'')}`);
console.log(`MATERIALIZER_TIMEOUT=${q(mat?.timeout_seconds||'')}`);
console.log(`REMINDER_ENABLED=${q(rem?'1':'0')}`);
console.log(`REMINDER_DECLARATION=${q(rem?.declaration_key||'')}`);
console.log(`REMINDER_NAME=${q(rem?.name||'')}`);
console.log(`REMINDER_CRON=${q(rem?.cron||'')}`);
console.log(`REMINDER_TIMEZONE=${q(rem?.timezone||'')}`);
console.log(`REMINDER_COMMAND_SUFFIX_JSON=${q(JSON.stringify(rem?.command_argv_suffix??[]))}`);
console.log(`REMINDER_TIMEOUT=${q(rem?.timeout_seconds||'')}`);
console.log(`REMINDER_CHANNEL=${q(rem?.delivery_channel||'')}`);
console.log(`REMINDER_ACCOUNT=${q(rem?.delivery_account||'')}`);
console.log(`IMPORTANT_DATE_ENABLED=${q(idr?'1':'0')}`);
console.log(`IMPORTANT_DATE_DECLARATION=${q(idr?.declaration_key||'')}`);
console.log(`IMPORTANT_DATE_NAME=${q(idr?.name||'')}`);
console.log(`IMPORTANT_DATE_CRON=${q(idr?.cron||'')}`);
console.log(`IMPORTANT_DATE_TIMEZONE=${q(idr?.timezone||'')}`);
console.log(`IMPORTANT_DATE_SCRIPT=${q(idr?.script||'')}`);
console.log(`IMPORTANT_DATE_TOOL=${q(idr?.tool||'')}`);
console.log(`IMPORTANT_DATE_TIMEOUT=${q(idr?.timeout_seconds||'')}`);
console.log(`IMPORTANT_DATE_TOOL_BUDGET=${q(idr?.tool_budget||'')}`);
console.log(`IMPORTANT_DATE_CHANNEL=${q(idr?.delivery_channel||'')}`);
console.log(`IMPORTANT_DATE_ACCOUNT=${q(idr?.delivery_account||'')}`);
console.log(`FROM_PLUGIN_VERSIONS=${q(r.from.plugin_versions.join(' '))}`);
console.log(`FROM_TOOLS_SHA=${q(r.from.tools_sha256||'')}`);
for(const f of files)console.log(`FROM_WS_${f.replace(/\./g,'_')}=${q(r.from.workspace_sha256?.[f]||'')}`);
NODE
) || fail_plain "Invalid Task Agent release metadata"
eval "$RELEASE_ENV"
TARGET_WORKSPACE_LAYOUT=$(node "$WORKSPACE_LAYOUT_HELPER" layout "$RELEASE_FILE") || fail_plain "Invalid Task Agent workspace layout"
read -r -a TARGET_WORKSPACE_FILES <<<"$(node "$WORKSPACE_LAYOUT_HELPER" target-files "$RELEASE_FILE")" || fail_plain "Invalid Task Agent workspace layout"
RECOVERY_FORMAT=$(node "$WORKSPACE_LAYOUT_HELPER" recovery-format "$RELEASE_FILE") || fail_plain "Invalid Task Agent recovery format"
[ "${#TARGET_WORKSPACE_FILES[@]}" -gt 0 ] || fail_plain "Target workspace file set is empty"

ARTIFACT="$ROOT/$ARTIFACT_REL"
CONTACTS_RELEASE=""; CONTACTS_PLUGIN_ARTIFACT=""; CONTACTS_FROM_SOURCE=""; CONTACTS_FROM_VERSION=""; CONTACTS_FROM_SCHEMA=""; CONTACTS_FROM_PLUGIN=""; CONTACTS_FROM_RELEASE_SHA=""
if [ "$CONTACTS_ENABLED" = "1" ]; then
  CONTACTS_RELEASE="$ROOT/$CONTACTS_RELEASE_REL"
  CONTACTS_PLUGIN_ARTIFACT="$CONTACTS_ROOT/$(node -e 'const r=require(process.argv[1]);const a=r?.plugin?.artifact;if(typeof a!=="string")process.exit(2);process.stdout.write(a)' "$CONTACTS_RELEASE")" || fail_plain "Invalid Shared Contacts plugin artifact"
  read -r CONTACTS_FROM_SOURCE CONTACTS_FROM_VERSION CONTACTS_FROM_SCHEMA CONTACTS_FROM_PLUGIN CONTACTS_FROM_RELEASE_SHA < <(node - "$CONTACTS_RELEASE" <<'NODE'
const r=require(process.argv[2]),f=r?.from;if(!f||!/^[0-9a-f]{40}$/.test(f.source_revision||'')||!/^0[.]1[.][0-9]+$/.test(f.implementation_version||'')||!Number.isSafeInteger(f.sqlite_schema)||f.sqlite_schema<1||!/^0[.]1[.][0-9]+$/.test(f.plugin_version||'')||!/^[0-9a-f]{64}$/.test(f.release_sha256||''))process.exit(2);process.stdout.write([f.source_revision,f.implementation_version,f.sqlite_schema,f.plugin_version,f.release_sha256].join(' ')+String.fromCharCode(10));
NODE
  ) || fail_plain "Invalid Shared Contacts predecessor metadata"
fi
ARTIFACT_SHA_FILE="${ARTIFACT%.tgz}.sha256"
TARGET_TOOLS_JSON=$(node -e "const fs=require('fs');process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))))" "$ROOT/config/tasks-tools.json" 2>/dev/null || true)
[ -n "$TARGET_TOOLS_JSON" ] || fail_plain "Unable to load target Task Agent tool policy"
TARGET_MAIN_CONTACTS_TOOLS_JSON=""
if [ "$CONTACTS_ENABLED" = "1" ]; then
  TARGET_MAIN_CONTACTS_TOOLS_JSON=$(node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(JSON.stringify(x)!==JSON.stringify({alsoAllow:['contacts']}))process.exit(2);process.stdout.write(JSON.stringify(x))" "$ROOT/config/main-contacts-tools.json" 2>/dev/null || true)
  [ -n "$TARGET_MAIN_CONTACTS_TOOLS_JSON" ] || fail_plain "Unable to load target main Contacts tool policy"
fi

if [ -n "$TEST_ROOT" ]; then
  case "$TEST_ROOT" in /*) ;; *) fail_plain "--test-root must be absolute";; esac
  mkdir -p "$TEST_ROOT"
  TEST_ROOT=$(realpath -e "$TEST_ROOT")
  case "$TEST_ROOT" in
    /|/home/dubrovin|/home/dubrovin/.openclaw|/home/dubrovin/.openclaw/*|/home/dubrovin/.local|/home/dubrovin/.local/*|/home/dubrovin/.config/systemd|/home/dubrovin/.config/systemd/*)
      fail_plain "Refusing unsafe test root: $TEST_ROOT" ;;
  esac
  HOME_DIR="$TEST_ROOT/home"
  STATE_DIR="$TEST_ROOT/state"
  WORKSPACE="$TEST_ROOT/workspace-tasks"
  BIN_DIR="$TEST_ROOT/bin"
  CONFIG="$STATE_DIR/openclaw.json"
  DB="$STATE_DIR/data/tasks/tasks.sqlite3"
  CONTACTS_DB="$STATE_DIR/data/contacts/contacts.sqlite3"
  CONTACTS_LIB="$HOME_DIR/.local/lib/openclaw-contacts"
  CONTACTCTL_TARGET="$BIN_DIR/contactctl"
  CONTACTS_PLUGIN_DIR="$STATE_DIR/extensions/contacts"
  PLUGIN_DIR="$STATE_DIR/extensions/taskctl"
  BACKUPS_ROOT="$TEST_ROOT/backups"
  DELIVERABLES="$TEST_ROOT/deliverables"
  LOCK_FILE="$TEST_ROOT/task-agent-deploy.lock"
else
  HOME_DIR="/home/dubrovin"
  STATE_DIR="$HOME_DIR/.openclaw"
  WORKSPACE="$STATE_DIR/workspace-tasks"
  BIN_DIR="$HOME_DIR/.local/bin"
  CONFIG="$STATE_DIR/openclaw.json"
  DB="$STATE_DIR/data/tasks/tasks.sqlite3"
  CONTACTS_DB="$STATE_DIR/data/contacts/contacts.sqlite3"
  CONTACTS_LIB="$HOME_DIR/.local/lib/openclaw-contacts"
  CONTACTCTL_TARGET="$BIN_DIR/contactctl"
  CONTACTS_PLUGIN_DIR="$STATE_DIR/extensions/contacts"
  PLUGIN_DIR="$STATE_DIR/extensions/taskctl"
  BACKUPS_ROOT="$STATE_DIR/backups"
  DELIVERABLES="$STATE_DIR/workspace/deliverables"
  LOCK_FILE="$STATE_DIR/task-agent-deploy.lock"
fi
TASKCTL_TARGET="$BIN_DIR/taskctl"
STATE_DB="$STATE_DIR/state/openclaw.sqlite"
MATERIALIZER_COMMAND_JSON=$(node -e 'process.stdout.write(JSON.stringify([process.argv[1],"recurrence","materialize"]))' "$TASKCTL_TARGET")
REMINDER_COMMAND_JSON=$(node -e 'const suffix=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify([process.argv[1],...suffix]))' "$TASKCTL_TARGET" "$REMINDER_COMMAND_SUFFIX_JSON")

OPENCLAW_BIN=$(command -v openclaw || true)
SYSTEMCTL_BIN=$(command -v systemctl || true)
[ -n "$OPENCLAW_BIN" ] || fail_plain "Required command unavailable: openclaw"
[ -n "$SYSTEMCTL_BIN" ] || fail_plain "Required command unavailable: systemctl"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
EXECUTION_ID="task-agent-deploy-${STAMP}-$$"
LOG_FILE=""
RESULT_FILE=""
GATEWAY_STOPPED=0
MUTATED=0
ROLLBACK_COUNT=0
RECOVERY_SET=""
SOURCE_REVISION=""
START_TASKCTL_VERSION=""
START_PLUGIN_VERSION=""
START_IS_TARGET=0
START_MATERIALIZER_EXACT=0
START_REMINDER_EXACT=0
REMINDER_DELIVERY_TO=""
START_IMPORTANT_DATE_EXACT=0
IMPORTANT_DATE_DELIVERY_TO=""
GATEWAY_READY_ATTEMPTS=160
GATEWAY_READY_SLEEP_SECONDS=0.25
if [ -n "$TEST_ROOT" ]; then
  GATEWAY_READY_ATTEMPTS=${TASK_AGENT_TEST_GATEWAY_READY_ATTEMPTS:-$GATEWAY_READY_ATTEMPTS}
  GATEWAY_READY_SLEEP_SECONDS=${TASK_AGENT_TEST_GATEWAY_READY_SLEEP_SECONDS:-$GATEWAY_READY_SLEEP_SECONDS}
fi

if [ "$MODE" = "apply" ]; then
  mkdir -p "$BACKUPS_ROOT" "$DELIVERABLES" "$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail_plain "Another Task Agent deployment is already running"
  LOG_FILE="$DELIVERABLES/${EXECUTION_ID}.log"
  RESULT_FILE="$DELIVERABLES/${EXECUTION_ID}-result.json"
  : > "$LOG_FILE"; chmod 600 "$LOG_FILE"; exec > >(tee -a "$LOG_FILE") 2>&1
fi

json_result(){
  [ "$MODE" = "apply" ] || return 0
  local result=$1 stage=$2 message=$3
  RESULT="$result" STAGE="$stage" MESSAGE="$message" \
  EXECUTION_ID_ENV="$EXECUTION_ID" SOURCE_REVISION_ENV="$SOURCE_REVISION" \
  RECOVERY_SET_ENV="$RECOVERY_SET" LOG_FILE_ENV="$LOG_FILE" \
  ROLLBACK_COUNT_ENV="$ROLLBACK_COUNT" GATEWAY_STOPPED_ENV="$GATEWAY_STOPPED" \
  MUTATED_ENV="$MUTATED" node - "$RESULT_FILE" <<'NODE'
const fs=require('fs');
const out={execution_id:process.env.EXECUTION_ID_ENV,result:process.env.RESULT,stage:process.env.STAGE,message:process.env.MESSAGE,source_revision:process.env.SOURCE_REVISION_ENV||null,recovery_set:process.env.RECOVERY_SET_ENV||null,rollback_count:Number(process.env.ROLLBACK_COUNT_ENV||0),gateway_stopped:process.env.GATEWAY_STOPPED_ENV==='1',mutation_started:process.env.MUTATED_ENV==='1',log:process.env.LOG_FILE_ENV||null};
fs.writeFileSync(process.argv[2],JSON.stringify(out,null,2)+'\n',{mode:0o600});
NODE
}

oc(){
  if [ -n "$TEST_ROOT" ]; then HOME="$HOME_DIR" OPENCLAW_HOME="$HOME_DIR" OPENCLAW_STATE_DIR="$STATE_DIR" OPENCLAW_CONFIG_PATH="$CONFIG" "$OPENCLAW_BIN" "$@"; else "$OPENCLAW_BIN" "$@"; fi
}
systemctl_user(){ if [ -n "$TEST_ROOT" ]; then TASK_AGENT_TEST_ROOT="$TEST_ROOT" "$SYSTEMCTL_BIN" --user "$@"; else "$SYSTEMCTL_BIN" --user "$@"; fi; }
gateway_rpc_ready(){ oc automations status --json >/dev/null 2>&1; }
wait_gateway_rpc_ready(){
  local attempt
  for ((attempt=1; attempt<=GATEWAY_READY_ATTEMPTS; attempt++)); do
    gateway_rpc_ready && return 0
    [ "$attempt" -lt "$GATEWAY_READY_ATTEMPTS" ] && sleep "$GATEWAY_READY_SLEEP_SECONDS"
  done
  return 1
}
calendar_materializer_jobs_json(){
  [ "$MATERIALIZER_ENABLED" = "1" ] || { printf '[]\n'; return 0; }
  local raw
  raw=$(oc automations list --all --json) || return 1
  node - "$MATERIALIZER_DECLARATION" "$raw" <<'NODE'
const key=process.argv[2],x=JSON.parse(process.argv[3]),jobs=Array.isArray(x)?x:(Array.isArray(x?.jobs)?x.jobs:[]);process.stdout.write(JSON.stringify(jobs.filter(j=>j?.declarationKey===key)));
NODE
}
calendar_materializer_exact(){
  [ "$MATERIALIZER_ENABLED" = "1" ] || return 0
  local jobs; jobs=$(calendar_materializer_jobs_json) || return 1
  node - "$jobs" "$MATERIALIZER_DECLARATION" "$MATERIALIZER_NAME" "$MATERIALIZER_CRON" "$MATERIALIZER_TIMEZONE" "$MATERIALIZER_TIMEOUT" "$MATERIALIZER_COMMAND_JSON" <<'NODE'
const jobs=JSON.parse(process.argv[2]),key=process.argv[3],name=process.argv[4],expr=process.argv[5],tz=process.argv[6],timeout=Number(process.argv[7]),argv=JSON.parse(process.argv[8]);if(jobs.length!==1)process.exit(1);const j=jobs[0];if(j.declarationKey!==key||j.name!==name||j.enabled!==true||j.agentId!=='tasks'||j.schedule?.kind!=='cron'||j.schedule?.expr!==expr||j.schedule?.tz!==tz||(j.schedule?.staggerMs??0)!==0||j.sessionTarget!=='isolated'||j.payload?.kind!=='command'||JSON.stringify(j.payload?.argv)!==JSON.stringify(argv)||j.payload?.timeoutSeconds!==timeout||j.delivery?.mode!=='none')process.exit(1);
NODE
}

resolve_reminder_delivery_to(){
  [ "$REMINDER_ENABLED" = "1" ] || { printf '\n'; return 0; }
  node - "$CONFIG" "$REMINDER_ACCOUNT" <<'NODE'
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),account=process.argv[3],a=c?.channels?.telegram?.accounts?.[account],bindings=Array.isArray(c?.bindings)?c.bindings:[];
if(!a||a.enabled!==true||a.dmPolicy!=='allowlist'||!Array.isArray(a.allowFrom)||a.allowFrom.length!==1||a.groupPolicy!=='allowlist'||!Array.isArray(a.groupAllowFrom)||a.groupAllowFrom.length!==1)process.exit(2);
const matches=bindings.filter(x=>x?.agentId==='tasks'&&x?.match?.channel==='telegram'&&x?.match?.accountId===account);if(matches.length!==1)process.exit(2);
const dest=String(a.allowFrom[0]??'').trim();if(!dest||String(a.groupAllowFrom[0]??'').trim()!==dest)process.exit(2);process.stdout.write(dest);
NODE
}
reminder_dispatcher_jobs_json(){
  [ "$REMINDER_ENABLED" = "1" ] || { printf '[]\n'; return 0; }
  local raw
  raw=$(oc automations list --all --json) || return 1
  node - "$REMINDER_DECLARATION" "$raw" <<'NODE'
const key=process.argv[2],x=JSON.parse(process.argv[3]),jobs=Array.isArray(x)?x:(Array.isArray(x?.jobs)?x.jobs:[]);process.stdout.write(JSON.stringify(jobs.filter(j=>j?.declarationKey===key)));
NODE
}
reminder_dispatcher_exact(){
  [ "$REMINDER_ENABLED" = "1" ] || return 0
  local jobs; jobs=$(reminder_dispatcher_jobs_json) || return 1
  node - "$jobs" "$REMINDER_DECLARATION" "$REMINDER_NAME" "$REMINDER_CRON" "$REMINDER_TIMEZONE" "$REMINDER_COMMAND_JSON" "$REMINDER_TIMEOUT" <<'NODE'
const jobs=JSON.parse(process.argv[2]),key=process.argv[3],name=process.argv[4],expr=process.argv[5],tz=process.argv[6],argv=JSON.parse(process.argv[7]),timeout=Number(process.argv[8]);if(jobs.length!==1)process.exit(1);const j=jobs[0],tools=j.payload?.toolsAllow,toolsExact=tools===undefined||(Array.isArray(tools)&&tools.length===0);if(j.declarationKey!==key||j.name!==name||typeof j.enabled!=='boolean'||j.agentId!=='tasks'||j.schedule?.kind!=='cron'||j.schedule?.expr!==expr||j.schedule?.tz!==tz||(j.schedule?.staggerMs??0)!==0||j.sessionTarget!=='isolated'||j.payload?.kind!=='command'||JSON.stringify(j.payload?.argv)!==JSON.stringify(argv)||j.payload?.timeoutSeconds!==timeout||!toolsExact||j.delivery?.mode!=='none'||j.scheduledToolPolicy!=null)process.exit(1);
NODE
}

resolve_important_date_delivery_to(){
  [ "$IMPORTANT_DATE_ENABLED" = "1" ] || { printf '\n'; return 0; }
  node - "$CONFIG" "$IMPORTANT_DATE_ACCOUNT" <<'NODE'
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),account=process.argv[3],bindings=Array.isArray(c?.bindings)?c.bindings:[],owner=c?.commands?.ownerAllowFrom;
if(c?.channels?.telegram?.enabled!==true||!Array.isArray(owner)||owner.length!==1)process.exit(2);
const ownerRoute=String(owner[0]??'').trim(),m=/^telegram:([1-9]\d*)$/.exec(ownerRoute);if(!m)process.exit(2);
const matches=bindings.filter(x=>x?.agentId==='main'&&x?.match?.channel==='telegram'&&x?.match?.accountId===account);if(matches.length!==1)process.exit(2);
process.stdout.write(m[1]);
NODE
}
important_date_dispatcher_jobs_json(){
  [ "$IMPORTANT_DATE_ENABLED" = "1" ] || { printf '[]\n'; return 0; }
  local raw
  raw=$(oc automations list --all --json) || return 1
  node - "$IMPORTANT_DATE_DECLARATION" "$raw" <<'NODE'
const key=process.argv[2],x=JSON.parse(process.argv[3]),jobs=Array.isArray(x)?x:(Array.isArray(x?.jobs)?x.jobs:[]);process.stdout.write(JSON.stringify(jobs.filter(j=>j?.declarationKey===key)));
NODE
}
important_date_dispatcher_exact(){
  [ "$IMPORTANT_DATE_ENABLED" = "1" ] || return 0
  local jobs destination; jobs=$(important_date_dispatcher_jobs_json) || return 1; destination=$IMPORTANT_DATE_DELIVERY_TO; [ -n "$destination" ] || destination=$(resolve_important_date_delivery_to) || return 1
  node - "$jobs" "$IMPORTANT_DATE_DECLARATION" "$IMPORTANT_DATE_NAME" "$IMPORTANT_DATE_CRON" "$IMPORTANT_DATE_TIMEZONE" "$IMPORTANT_DATE_SCRIPT" "$IMPORTANT_DATE_TOOL" "$IMPORTANT_DATE_TIMEOUT" "$IMPORTANT_DATE_TOOL_BUDGET" "$IMPORTANT_DATE_CHANNEL" "$IMPORTANT_DATE_ACCOUNT" "$destination" <<'NODE'
const jobs=JSON.parse(process.argv[2]),key=process.argv[3],name=process.argv[4],expr=process.argv[5],tz=process.argv[6],script=process.argv[7],tool=process.argv[8],timeout=Number(process.argv[9]),budget=Number(process.argv[10]),channel=process.argv[11],account=process.argv[12],to=process.argv[13];if(jobs.length!==1)process.exit(1);const j=jobs[0];if(j.declarationKey!==key||j.name!==name||j.enabled!==true||j.agentId!=='main'||j.schedule?.kind!=='cron'||j.schedule?.expr!==expr||j.schedule?.tz!==tz||(j.schedule.staggerMs??0)!==0||j.sessionTarget!=='isolated'||j.payload?.kind!=='script'||j.payload?.script!==script||JSON.stringify(j.payload?.toolsAllow)!==JSON.stringify([tool])||j.payload?.timeoutSeconds!==timeout||j.payload?.toolBudget!==budget||j.delivery?.mode!=='announce'||j.delivery?.channel!==channel||String(j.delivery?.to)!==to||j.delivery?.accountId!==account||(j.delivery?.bestEffort!==undefined&&j.delivery?.bestEffort!==false))process.exit(1);
NODE
}

taskctl_health(){ if [ -n "$TEST_ROOT" ]; then HOME="$HOME_DIR" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_CONTACTS_DB="$CONTACTS_DB" "$TASKCTL_TARGET" health; else "$TASKCTL_TARGET" health; fi; }
taskctl_migrate(){ if [ -n "$TEST_ROOT" ]; then HOME="$HOME_DIR" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_CONTACTS_DB="$CONTACTS_DB" "$TASKCTL_TARGET" init; else "$TASKCTL_TARGET" init; fi; }
contactctl_health(){ if [ -n "$TEST_ROOT" ]; then HOME="$HOME_DIR" CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$CONTACTS_DB" CONTACTCTL_PAYLOAD='{}' "$CONTACTCTL_TARGET" health; else CONTACTCTL_PAYLOAD='{}' "$CONTACTCTL_TARGET" health; fi; }
contactctl_migrate(){ if [ -n "$TEST_ROOT" ]; then HOME="$HOME_DIR" CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$CONTACTS_DB" "$CONTACTCTL_TARGET" init; else "$CONTACTCTL_TARGET" init; fi; }
taskctl_payload(){ local payload=$1 scope=$2 action=$3; if [ -n "$TEST_ROOT" ]; then HOME="$HOME_DIR" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_CONTACTS_DB="$CONTACTS_DB" TASKCTL_PAYLOAD="$payload" "$TASKCTL_TARGET" "$scope" "$action"; else TASKCTL_PAYLOAD="$payload" "$TASKCTL_TARGET" "$scope" "$action"; fi; }
contactctl_payload(){ local payload=$1 action=$2; if [ -n "$TEST_ROOT" ]; then HOME="$HOME_DIR" CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$CONTACTS_DB" CONTACTCTL_PAYLOAD="$payload" "$CONTACTCTL_TARGET" "$action"; else CONTACTCTL_PAYLOAD="$payload" "$CONTACTCTL_TARGET" "$action"; fi; }
governance_bindings_exact(){
  local out; out=$(taskctl_payload '{}' config validate 2>/dev/null) || return 1
  node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||!/^PG-[1-9]\d*$/.test(x.office_ceo_group_id||"")||!/^L-[1-9]\d*$/.test(x.personal_label_id||""))process.exit(1)' "$out"
}
start_gateway_best_effort(){ systemctl_user start openclaw-gateway.service >/dev/null 2>&1 || true; GATEWAY_STOPPED=0; }

abort_deploy(){
  local stage=$1 message=$2
  echo "FAILED[$stage]: $message" >&2
  if [ "$MODE" = "apply" ] && [ "$MUTATED" -eq 1 ] && [ -n "$RECOVERY_SET" ] && [ -d "$RECOVERY_SET" ]; then
    ROLLBACK_COUNT=$((ROLLBACK_COUNT+1))
    local recover_args=(--apply --confirm-outage --from "$RECOVERY_SET")
    if [ -n "$TEST_ROOT" ]; then recover_args=(--test-root "$TEST_ROOT" "${recover_args[@]}"); fi
    if "$ROOT/recover.sh" "${recover_args[@]}"; then GATEWAY_STOPPED=0; json_result "ROLLED_BACK" "$stage" "$message"; echo "RESULT_FILE=$RESULT_FILE"; exit 1; fi
    json_result "BLOCKED" "$stage" "$message; rollback failed"; echo "RESULT_FILE=$RESULT_FILE"; exit 2
  fi
  if [ "$MODE" = "apply" ] && [ "$GATEWAY_STOPPED" -eq 1 ]; then start_gateway_best_effort; fi
  json_result "BLOCKED" "$stage" "$message"
  [ -n "$RESULT_FILE" ] && echo "RESULT_FILE=$RESULT_FILE"
  exit 2
}

read_db_state(){
  node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const uv=Number(db.prepare('PRAGMA user_version').get().user_version),integrity=db.prepare('PRAGMA integrity_check').get().integrity_check,fk=db.prepare('PRAGMA foreign_key_check').all().length;
  const cols=n=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n)?db.prepare(`PRAGMA table_info("${n}")`).all().map(x=>x.name):[];
  const labels=cols('labels'),tasks=cols('tasks'),projects=cols('projects'),ev=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_events'").get()?.sql||'',base=labels.includes('emoji')&&tasks.includes('assignee_id')&&tasks.includes('project_id')&&['id','title','status','created_at','completed_at'].every(x=>projects.includes(x))&&ev.includes('DUE_TIME_CHANGED');
  const rec=cols('recurrences'),rl=cols('recurrence_labels'),ro=cols('recurrence_occurrences'),re=cols('recurrence_events'),people=cols('people'),aliases=cols('person_aliases');
  const recurrenceShape=['id','status','mode','title','assignee_id','due_time','target_project_id','rule_json','calendar_cursor_date','created_at','updated_at','cancelled_at'].every(x=>rec.includes(x))&&['recurrence_id','label_id'].every(x=>rl.includes(x))&&['id','recurrence_id','occurrence_key','occurrence_date','predecessor_task_id','task_id','template_json','generated_at'].every(x=>ro.includes(x))&&['id','recurrence_id','event_type','old_value','new_value','reason','occurred_at'].every(x=>re.includes(x));
  const reminders=cols('reminders'),reminderShape=['id','task_id','text','trigger_at','status','close_reason','created_at','closed_at','claim_token','claimed_at','claim_expires_at'].every(x=>reminders.includes(x));
  const bindings=cols('task_domain_bindings'),requests=cols('deadline_change_requests'),governanceShape=['binding_key','entity_id','created_at','updated_at'].every(x=>bindings.includes(x))&&['id','task_id','base_due_date','base_due_time','requested_due_date','requested_due_time','reason','status','approved_due_date','approved_due_time','created_at','resolved_at'].every(x=>requests.includes(x));
  const physical_current=base&&recurrenceShape&&people.length===0&&aliases.length===0&&reminderShape&&governanceShape;
  process.stdout.write(JSON.stringify({user_version:uv,integrity,fk,physical_current}));
}finally{db.close();}
NODE
}
current_tools_sha(){
  node - "$CONFIG" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),v=c?.agents?.entries?.tasks?.tools;if(!v)process.exit(2);const stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';process.stdout.write(crypto.createHash('sha256').update(stable(v)).digest('hex'));
NODE
}
config_tools_match_target(){
  node - "$CONFIG" "$ROOT/config/tasks-tools.json" <<'NODE'
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),want=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),got=c?.agents?.entries?.tasks?.tools;const stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';if(stable(got)!==stable(want))process.exit(1);
NODE
}
main_contacts_policy_target_exact(){
  [ "$CONTACTS_ENABLED" = "1" ] || return 0
  node - "$CONFIG" "$ROOT/config/main-contacts-tools.json" <<'NODE'
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),want=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),got=c?.agents?.entries?.main?.tools;const stable=x=>x===null||typeof x!=="object"?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';if(c?.tools?.profile!=="coding"||stable(got)!==stable(want))process.exit(1);
NODE
}
main_contacts_policy_starting_eligible(){ [ "$CONTACTS_ENABLED" != "1" ] || main_contacts_policy_target_exact; }
workspace_matches_target(){
  local f
  for f in "${TARGET_WORKSPACE_FILES[@]}"; do cmp -s "$ROOT/workspace/$f" "$WORKSPACE/$f" || return 1; done
  if [ "$TARGET_WORKSPACE_LAYOUT" = "agents-md-tools-v1" ]; then [ ! -e "$WORKSPACE/TOOLS.md" ] || return 1; fi
}
workspace_matches_from(){
  local f expected actual var
  for f in "${TARGET_WORKSPACE_FILES[@]}"; do
    var="FROM_WS_${f//./_}"; expected=${!var}; [ -n "$expected" ] || return 1
    actual=$(sha256sum "$WORKSPACE/$f" 2>/dev/null|awk '{print $1}') || return 1
    [ "$actual" = "$expected" ] || return 1
  done
  [ ! -e "$WORKSPACE/TOOLS.md" ] || return 1
}
plugin_version(){ node -e "const p=require(process.argv[1]);process.stdout.write(String(p.version||''))" "$PLUGIN_DIR/package.json" 2>/dev/null; }
plugin_identity_matches_target(){ local pv tv; pv=$(plugin_version) || return 1; [ "$pv" = "$TARGET_PLUGIN_VERSION" ] || return 1; tv=$(node -e "const p=require(process.argv[1]);process.stdout.write(String(p.version||''))" "$PLUGIN_DIR/node_modules/typebox/package.json" 2>/dev/null) || return 1; [ "$tv" = "1.3.15" ]; }
taskctl_runtime_identity(){ local health; health=$(taskctl_health 2>/dev/null) || return 1; node -e 'const h=JSON.parse(process.argv[1]);if(!/^0\.4\.[0-9]+$/.test(h.implementation_version||"")||!Number.isSafeInteger(h.schema_version))process.exit(1);process.stdout.write(`${h.implementation_version} ${h.schema_version}`)' "$health"; }
taskctl_version(){ local identity; identity=$(taskctl_runtime_identity) || return 1; printf '%s\n' "${identity%% *}"; }
contacts_source_exact(){
  [ "$CONTACTS_ENABLED" = "1" ] || return 0
  [ -f "$CONTACTS_RELEASE" ] && [ "$(sha256sum "$CONTACTS_RELEASE"|awk '{print $1}')" = "$EXPECTED_CONTACTS_RELEASE_SHA" ] || return 1
  [ -f "$CONTACTS_ROOT/core.cjs" ] && [ -f "$CONTACTS_ROOT/task-store.cjs" ] && [ -x "$CONTACTS_ROOT/contactctl" ] && [ -f "$ROOT/config/main-contacts-tools.json" ] || return 1
  node - "$ROOT/config/main-contacts-tools.json" <<'NODE' || return 1
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(JSON.stringify(x)!==JSON.stringify({alsoAllow:['contacts']}))process.exit(1);
NODE
  node - "$CONTACTS_RELEASE" "$CONTACTS_ROOT" "$TARGET_CONTACTS_VERSION" "$TARGET_CONTACTS_SCHEMA" <<'NODE' || return 1
const fs=require('fs'),crypto=require('crypto'),path=require('path'),r=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),root=process.argv[3],v=process.argv[4],schema=Number(process.argv[5]),sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');if(r?.format!=='shared-contacts-release-v1'||r.implementation_version!==v||r.sqlite_schema!==schema)process.exit(2);for(const f of ['core.cjs','task-store.cjs','contactctl'])if(r.runtime_files?.[f]!==sha(path.join(root,f)))process.exit(2);const a=path.join(root,r.plugin.artifact);if(r.plugin?.name!=='openclaw-plugin-contacts'||r.plugin?.version!==v||r.plugin?.sha256!==sha(a))process.exit(2);
NODE
  node --check "$CONTACTS_ROOT/core.cjs" >/dev/null && node --check "$CONTACTS_ROOT/task-store.cjs" >/dev/null && node --check "$CONTACTS_ROOT/contactctl" >/dev/null || return 1
  local tmp out; tmp=$(mktemp -d) || return 1; out=$(CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$tmp/contacts.sqlite3" "$CONTACTS_ROOT/contactctl" init 2>/dev/null) || { rm -rf "$tmp"; return 1; }; rm -rf "$tmp"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3]))process.exit(1)' "$out" "$TARGET_CONTACTS_VERSION" "$TARGET_CONTACTS_SCHEMA"
}
contacts_runtime_exact(){
  [ "$CONTACTS_ENABLED" = "1" ] || return 0
  [ -x "$CONTACTCTL_TARGET" ] && [ -f "$CONTACTS_LIB/core.cjs" ] && [ -f "$CONTACTS_LIB/task-store.cjs" ] && [ -f "$CONTACTS_DB" ] && [ -f "$CONTACTS_PLUGIN_DIR/package.json" ] || return 1
  cmp -s "$CONTACTS_ROOT/contactctl" "$CONTACTCTL_TARGET" && cmp -s "$CONTACTS_ROOT/core.cjs" "$CONTACTS_LIB/core.cjs" && cmp -s "$CONTACTS_ROOT/task-store.cjs" "$CONTACTS_LIB/task-store.cjs" || return 1
  local h inspect; h=$(contactctl_health 2>/dev/null) || return 1
  node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3])||x.integrity?.ok!==true)process.exit(1)' "$h" "$TARGET_CONTACTS_VERSION" "$TARGET_CONTACTS_SCHEMA" || return 1
  inspect=$(oc plugins inspect contacts --runtime --json 2>/dev/null) || return 1
  node - "$inspect" "$TARGET_CONTACTS_VERSION" "$CONTACTS_ROOT/plugin/openclaw.plugin.json" <<'NODE' || return 1
const fs=require('fs'),x=JSON.parse(process.argv[2]),p=x?.plugin,v=process.argv[3],m=JSON.parse(fs.readFileSync(process.argv[4],'utf8')),expected=m?.contracts?.tools;if(!Array.isArray(expected)||p?.id!=='contacts'||p?.packageVersion!==v||p?.enabled!==true||p?.status!=='loaded'||!expected.every(t=>p.toolNames?.includes(t)))process.exit(1);
NODE
}
contacts_predecessor_exact(){
  [ "$CONTACTS_ENABLED" = "1" ] || return 0
  [ -n "$CONTACTS_FROM_SOURCE" ] || return 1
  [ -x "$CONTACTCTL_TARGET" ] && [ -f "$CONTACTS_LIB/core.cjs" ] && [ -f "$CONTACTS_LIB/task-store.cjs" ] && [ -f "$CONTACTS_DB" ] && [ -f "$CONTACTS_PLUGIN_DIR/package.json" ] || return 1
  local tmp release h inspect
  tmp=$(mktemp) || return 1
  git -C "$REPO_ROOT" show "$CONTACTS_FROM_SOURCE:shared/contacts/release.json" >"$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  [ "$(sha256sum "$tmp"|awk '{print $1}')" = "$CONTACTS_FROM_RELEASE_SHA" ] || { rm -f "$tmp"; return 1; }
  node - "$tmp" "$CONTACTS_LIB" "$CONTACTCTL_TARGET" "$CONTACTS_FROM_VERSION" "$CONTACTS_FROM_SCHEMA" "$CONTACTS_FROM_PLUGIN" <<'NODE' || { rm -f "$tmp"; return 1; }
const fs=require('fs'),crypto=require('crypto'),path=require('path'),r=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),lib=process.argv[3],ctl=process.argv[4],v=process.argv[5],schema=Number(process.argv[6]),plugin=process.argv[7],sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');if(r.implementation_version!==v||r.sqlite_schema!==schema||r.plugin?.version!==plugin)process.exit(2);if(r.runtime_files?.['core.cjs']!==sha(path.join(lib,'core.cjs'))||r.runtime_files?.['task-store.cjs']!==sha(path.join(lib,'task-store.cjs'))||r.runtime_files?.contactctl!==sha(ctl))process.exit(2);
NODE
  rm -f "$tmp"
  h=$(contactctl_health 2>/dev/null) || return 1
  node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3])||x.integrity?.ok!==true)process.exit(1)' "$h" "$CONTACTS_FROM_VERSION" "$CONTACTS_FROM_SCHEMA" || return 1
  inspect=$(oc plugins inspect contacts --runtime --json 2>/dev/null) || return 1
  node - "$inspect" "$CONTACTS_FROM_PLUGIN" "$REPO_ROOT" "$CONTACTS_FROM_SOURCE" <<'NODE' || return 1
const {execFileSync}=require('child_process'),x=JSON.parse(process.argv[2]),p=x?.plugin,v=process.argv[3],repo=process.argv[4],sha=process.argv[5];const m=JSON.parse(execFileSync('git',['-C',repo,'show',sha+':shared/contacts/plugin/openclaw.plugin.json'],{encoding:'utf8'})),expected=m?.contracts?.tools;if(!Array.isArray(expected)||p?.id!=='contacts'||p?.packageVersion!==v||p?.enabled!==true||p?.status!=='loaded'||!expected.every(t=>p.toolNames?.includes(t)))process.exit(1);
NODE
}
contacts_starting_eligible(){ [ "$CONTACTS_ENABLED" != "1" ] || contacts_predecessor_exact; }
taskctl_target_exact(){ local identity; [ -x "$TASKCTL_TARGET" ] && cmp -s "$ROOT/taskctl" "$TASKCTL_TARGET" || return 1; identity=$(taskctl_runtime_identity) || return 1; [ "$identity" = "$TARGET_TASKCTL_VERSION $TARGET_SQLITE_SCHEMA" ]; }
taskctl_starting_eligible(){ local identity; identity=$(taskctl_runtime_identity) || return 1; [ "$identity" = "$FROM_TASKCTL_VERSIONS $FROM_SQLITE_SCHEMAS" ]; }
db_generation_exact(){ local state; state=$(read_db_state) || return 1; node -e 'const s=JSON.parse(process.argv[1]),want=Number(process.argv[2]);if(s.user_version!==want||s.integrity!=="ok"||s.fk!==0||!s.physical_current)process.exit(1)' "$state" "$TARGET_SQLITE_SCHEMA"; }
db_starting_eligible(){ local state; state=$(read_db_state) || return 1; node -e 'const s=JSON.parse(process.argv[1]),want=Number(process.argv[2]);if(s.user_version!==want||s.integrity!=="ok"||s.fk!==0||!s.physical_current)process.exit(1)' "$state" "$FROM_SQLITE_SCHEMAS"; }
target_runtime_exact(){ db_generation_exact && contacts_runtime_exact && taskctl_target_exact && governance_bindings_exact && plugin_identity_matches_target && workspace_matches_target && config_tools_match_target && main_contacts_policy_target_exact && oc config validate >/dev/null 2>&1; }
starting_runtime_eligible(){
  db_starting_eligible || return 1
  taskctl_starting_eligible || return 1
  contacts_starting_eligible || return 1
  governance_bindings_exact || return 1
  main_contacts_policy_starting_eligible || return 1
  [ "$(plugin_version)" = "$FROM_PLUGIN_VERSIONS" ] || return 1
  workspace_matches_from || return 1
  [ "$(current_tools_sha)" = "$FROM_TOOLS_SHA" ] || return 1
  oc config validate >/dev/null 2>&1 || return 1
}

source_taskctl_identity_exact(){
  [ -x "$ROOT/taskctl" ] || return 1
  local tmp out code=0; tmp=$(mktemp -d) || return 1
  out=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$tmp/tasks.sqlite3" "$ROOT/taskctl" init 2>/dev/null) || code=$?
  rm -rf "$tmp"
  [ "$code" -eq 0 ] || return 1
  node -e 'const h=JSON.parse(process.argv[1]),v=process.argv[2];if(h.implementation_version!==v||h.schema_version!==Number(process.argv[3]))process.exit(1)' "$out" "$TARGET_TASKCTL_VERSION" "$TARGET_SQLITE_SCHEMA"
}

validate_source(){
  [ -n "$REPO_ROOT" ] || abort_deploy "SOURCE" "repository root unavailable"
  SOURCE_REVISION=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null) || abort_deploy "SOURCE" "cannot resolve source revision"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- agents/tasks shared/contacts runtime-contract.json shared/runtime-contract)" ] || abort_deploy "SOURCE" "runtime-affecting checkout is not clean"
  node "$RUNTIME_HELPER" repo-check "$RUNTIME_CONTRACT_ROOT" >/dev/null || abort_deploy "SOURCE" "repository runtime contract mismatch"
  node --check "$WORKSPACE_LAYOUT_HELPER" >/dev/null || abort_deploy "SOURCE" "workspace layout helper syntax invalid"
  node --check "$PLUGIN_REGISTRY_HELPER" >/dev/null || abort_deploy "SOURCE" "plugin registry state helper syntax invalid"
  source_taskctl_identity_exact || abort_deploy "SOURCE" "taskctl source identity does not match release generation"
  contacts_source_exact || abort_deploy "SOURCE" "Shared Contacts source identity does not match release generation"
  [ -f "$ARTIFACT" ] && [ -f "$ARTIFACT_SHA_FILE" ] || abort_deploy "SOURCE" "release artifact or SHA file missing"
  local actual listed pkgver f
  actual=$(sha256sum "$ARTIFACT"|awk '{print $1}'); listed=$(awk 'NF{print $1;exit}' "$ARTIFACT_SHA_FILE"); [ "$actual" = "$EXPECTED_ARTIFACT_SHA" ] && [ "$listed" = "$EXPECTED_ARTIFACT_SHA" ] || abort_deploy "SOURCE" "release artifact SHA mismatch"
  node - "$ROOT/plugins/taskctl/package.json" "$ROOT/plugins/taskctl/package-lock.json" "$ROOT/plugins/taskctl/openclaw.plugin.json" "$TARGET_PLUGIN_VERSION" "$RELEASE_FILE" <<'NODE' || abort_deploy "SOURCE" "plugin source identity mismatch"
const fs=require('fs'),v=process.argv[5],p=JSON.parse(fs.readFileSync(process.argv[2])),l=JSON.parse(fs.readFileSync(process.argv[3])),m=JSON.parse(fs.readFileSync(process.argv[4])),rel=JSON.parse(fs.readFileSync(process.argv[6])),root=l.packages?.[''],t=l.packages?.['node_modules/typebox'];const build=rel?.generation?.openclaw_build_version,compat=rel?.generation?.openclaw_compat;if(p.name!=='openclaw-plugin-taskctl'||p.version!==v||m.id!=='taskctl'||m.version!==v||l.version!==v||root?.version!==v||p.dependencies?.typebox!=='1.3.15'||root?.dependencies?.typebox!=='1.3.15'||t?.version!=='1.3.15'||p.devDependencies?.openclaw!==build||root?.devDependencies?.openclaw!==build||p.openclaw?.build?.openclawVersion!==build||p.peerDependencies?.openclaw!==compat||root?.peerDependencies?.openclaw!==compat||p.openclaw?.compat?.pluginApi!==compat)process.exit(2);
NODE
  pkgver=$(node - "$ARTIFACT" "$RELEASE_FILE" <<'NODE'
const {execFileSync}=require('child_process'),fs=require('fs'),j=JSON.parse(execFileSync('tar',['-xOf',process.argv[2],'package/package.json'],{encoding:'utf8'})),r=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),build=r?.generation?.openclaw_build_version,compat=r?.generation?.openclaw_compat;if(j.name!=='openclaw-plugin-taskctl'||j.devDependencies?.openclaw!==build||j.openclaw?.build?.openclawVersion!==build||j.peerDependencies?.openclaw!==compat||j.openclaw?.compat?.pluginApi!==compat)process.exit(2);process.stdout.write(j.version);
NODE
) || abort_deploy "SOURCE" "artifact package identity invalid"
  [ "$pkgver" = "$TARGET_PLUGIN_VERSION" ] || abort_deploy "SOURCE" "artifact package version mismatch"
  for f in "${TARGET_WORKSPACE_FILES[@]}"; do [ -f "$ROOT/workspace/$f" ] || abort_deploy "SOURCE" "workspace source missing: $f"; done
  bash -n "$ROOT/deploy.sh" || abort_deploy "SOURCE" "deploy runner syntax invalid"; bash -n "$ROOT/recover.sh" || abort_deploy "SOURCE" "recovery runner syntax invalid"
}

validate_live_boundary(){
  local version
  version=$(oc --version 2>/dev/null|awk '{print $2}') || abort_deploy "PREFLIGHT" "OpenClaw version unavailable"; [ "$version" = "$EXPECTED_OPENCLAW_VERSION" ] || abort_deploy "PREFLIGHT" "unsupported OpenClaw generation: $version (expected $EXPECTED_OPENCLAW_VERSION)"
  [ -f "$CONFIG" ] && [ -f "$DB" ] && [ -x "$TASKCTL_TARGET" ] && [ -f "$PLUGIN_DIR/package.json" ] || abort_deploy "PREFLIGHT" "required runtime files missing"
  systemctl_user is-active --quiet openclaw-gateway.service || abort_deploy "PREFLIGHT" "Gateway is not active"
  node - "$CONFIG" <<'NODE' || abort_deploy "PREFLIGHT" "Task Agent config entry unavailable"
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(!c?.agents?.entries?.tasks)process.exit(2);
NODE
  START_TASKCTL_VERSION=$(taskctl_version) || abort_deploy "PREFLIGHT" "current taskctl identity is unavailable or incompatible"
  START_PLUGIN_VERSION=$(plugin_version) || abort_deploy "PREFLIGHT" "current plugin identity is unavailable"
  if [ "$REMINDER_ENABLED" = "1" ]; then REMINDER_DELIVERY_TO=$(resolve_reminder_delivery_to) || abort_deploy "PREFLIGHT" "Tasks Telegram owner-only Reminder delivery route is not exact"; fi
  if [ "$IMPORTANT_DATE_ENABLED" = "1" ]; then IMPORTANT_DATE_DELIVERY_TO=$(resolve_important_date_delivery_to) || abort_deploy "PREFLIGHT" "main Telegram owner Important Dates delivery route is not exact"; fi
  if target_runtime_exact; then
    if [ "$MATERIALIZER_ENABLED" = "1" ]; then
      calendar_materializer_exact || abort_deploy "PREFLIGHT" "target runtime has Recurrence materializer scheduler drift"
      START_MATERIALIZER_EXACT=1
    fi
    if [ "$REMINDER_ENABLED" = "1" ]; then reminder_dispatcher_exact || abort_deploy "PREFLIGHT" "target runtime has Reminder dispatcher drift"; START_REMINDER_EXACT=1; fi
    if [ "$IMPORTANT_DATE_ENABLED" = "1" ]; then important_date_dispatcher_exact || abort_deploy "PREFLIGHT" "target runtime has Important Dates dispatcher drift"; START_IMPORTANT_DATE_EXACT=1; fi
    START_IS_TARGET=1
    return 0
  fi
  [ -n "$FROM_PLUGIN_VERSIONS" ] || abort_deploy "PREFLIGHT" "runtime is not exact target and release declares no eligible starting generation"
  starting_runtime_eligible || abort_deploy "PREFLIGHT" "runtime does not match declared starting fingerprint"
  if [ "$MATERIALIZER_ENABLED" = "1" ]; then calendar_materializer_exact || abort_deploy "PREFLIGHT" "declared predecessor Recurrence materializer is missing or drifted"; START_MATERIALIZER_EXACT=1; fi
  if [ "$REMINDER_ENABLED" = "1" ]; then reminder_dispatcher_exact || abort_deploy "PREFLIGHT" "declared predecessor Reminder dispatcher is missing or drifted"; START_REMINDER_EXACT=1; fi
  if [ "$IMPORTANT_DATE_ENABLED" = "1" ]; then important_date_dispatcher_exact || abort_deploy "PREFLIGHT" "declared predecessor Important Dates dispatcher is missing or drifted"; START_IMPORTANT_DATE_EXACT=1; fi
  oc config set "agents.entries.tasks.tools" "$TARGET_TOOLS_JSON" --strict-json --dry-run >/dev/null || abort_deploy "PREFLIGHT" "target Task Agent tool policy is not accepted by OpenClaw"
}

create_recovery_set(){
  RECOVERY_SET="$BACKUPS_ROOT/task-agent-stage-$STAMP"; mkdir -m 700 "$RECOVERY_SET" || return 1
  install -m 600 "$CONFIG" "$RECOVERY_SET/openclaw.json.before" || return 1; install -m 700 "$TASKCTL_TARGET" "$RECOVERY_SET/taskctl.before" || return 1
  node - "$DB" "$RECOVERY_SET/tasks.sqlite3" <<'NODE' || return 1
const {DatabaseSync,backup}=require('node:sqlite');const fs=require('fs');(async()=>{const db=new DatabaseSync(process.argv[2],{readOnly:true});try{await backup(db,process.argv[3]);}finally{db.close();}fs.chmodSync(process.argv[3],0o600);})().catch(e=>{console.error(e);process.exit(2)});
NODE
  [ -f "$CONTACTS_DB" ] && [ -d "$CONTACTS_LIB" ] && [ -x "$CONTACTCTL_TARGET" ] && [ -d "$CONTACTS_PLUGIN_DIR" ] || return 1
  local contacts_schema_version
  contacts_schema_version=$(node - "$CONTACTS_DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});try{const v=Number(d.prepare('pragma user_version').get().user_version);if(!Number.isSafeInteger(v)||v<1)process.exit(2);process.stdout.write(String(v));}finally{d.close();}
NODE
) || return 1
  node - "$RECOVERY_SET/contacts-state.json" "$contacts_schema_version" <<'NODE' || return 1
const fs=require('fs'),schema=Number(process.argv[3]);if(!Number.isSafeInteger(schema)||schema<1)process.exit(2);const out={format:'shared-contacts-recovery-v2',db_present:true,lib_present:true,contactctl_present:true,plugin_present:true,schema_version:schema};fs.writeFileSync(process.argv[2],JSON.stringify(out,null,2)+String.fromCharCode(10),{mode:0o600});
NODE
  node - "$CONTACTS_DB" "$RECOVERY_SET/contacts.sqlite3" <<'NODE' || return 1
const {DatabaseSync,backup}=require('node:sqlite');const fs=require('fs');(async()=>{const db=new DatabaseSync(process.argv[2],{readOnly:true});try{await backup(db,process.argv[3]);}finally{db.close();}fs.chmodSync(process.argv[3],0o600);})().catch(e=>{console.error(e);process.exit(2)});
NODE
  tar -czf "$RECOVERY_SET/contacts-lib.before.tar.gz" -C "$(dirname "$CONTACTS_LIB")" "$(basename "$CONTACTS_LIB")" || return 1
  install -m 700 "$CONTACTCTL_TARGET" "$RECOVERY_SET/contactctl.before" || return 1
  tar --exclude='contacts/node_modules/openclaw' -czf "$RECOVERY_SET/contacts-plugin.before.tar.gz" -C "$(dirname "$CONTACTS_PLUGIN_DIR")" contacts || return 1
  node "$PLUGIN_REGISTRY_HELPER" snapshot "$STATE_DB" "$RECOVERY_SET/plugin-registry.before.json" || return 1
  tar --exclude='taskctl/node_modules/openclaw' -czf "$RECOVERY_SET/taskctl-managed.before.tar.gz" -C "$(dirname "$PLUGIN_DIR")" taskctl || return 1
  local args=() f; for f in "${TARGET_WORKSPACE_FILES[@]}"; do args+=("workspace-tasks/$f"); done; tar -czf "$RECOVERY_SET/workspace-tasks.before.tar.gz" -C "$(dirname "$WORKSPACE")" "${args[@]}" || return 1
  printf '%s\n' "$RECOVERY_FORMAT" > "$RECOVERY_SET/RECOVERY_FORMAT"
  local checksum_files=(RECOVERY_FORMAT openclaw.json.before taskctl.before tasks.sqlite3 taskctl-managed.before.tar.gz workspace-tasks.before.tar.gz contacts-state.json contacts.sqlite3 contacts-lib.before.tar.gz contactctl.before contacts-plugin.before.tar.gz plugin-registry.before.json)
  (cd "$RECOVERY_SET" && sha256sum "${checksum_files[@]}" > SHA256SUMS) || return 1; chmod 600 "$RECOVERY_SET"/* || return 1
  local a=(--inspect --from "$RECOVERY_SET") code=0; if [ -n "$TEST_ROOT" ]; then a=(--test-root "$TEST_ROOT" "${a[@]}"); fi; "$ROOT/recover.sh" "${a[@]}" >/dev/null 2>&1 || code=$?; [ "$code" -eq 3 ]
}

validate_plugin_surface(){
  local inspect expected; inspect=$(oc plugins inspect taskctl --runtime --json) || return 1
  expected=$(node - "$ROOT/plugins/taskctl/openclaw.plugin.json" <<'NODE'
const fs=require('fs'),m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),t=m?.contracts?.tools;if(!Array.isArray(t)||t.some(x=>typeof x!=='string'||!x))process.exit(2);process.stdout.write(JSON.stringify(t));
NODE
) || return 1
  node -e 'const x=JSON.stringify(JSON.parse(process.argv[1])),tools=JSON.parse(process.argv[2]);if(!tools.every(t=>x.includes(`"${t}"`)))process.exit(1)' "$inspect" "$expected"
}
validate_target(){
  target_runtime_exact || return 1; validate_plugin_surface || return 1
  if [ "$CONTACTS_ENABLED" = "1" ]; then node "$PLUGIN_REGISTRY_HELPER" verify-target "$STATE_DB" "$EXPECTED_OPENCLAW_VERSION" "$TARGET_PLUGIN_VERSION" "$TARGET_CONTACTS_VERSION" || return 1; fi
  [ "$(stat -c %a "$TASKCTL_TARGET")" = 700 ] || return 1; [ "$(stat -c %a "$CONFIG")" = 600 ] || return 1; [ "$(stat -c %a "$DB")" = 600 ] || return 1; [ "$CONTACTS_ENABLED" != "1" ] || { [ "$(stat -c %a "$CONTACTS_DB")" = 600 ] && [ "$(stat -c %a "$CONTACTCTL_TARGET")" = 700 ] && [ "$(stat -c %a "$CONTACTS_LIB/core.cjs")" = 600 ]; } || return 1
  local f; for f in "${TARGET_WORKSPACE_FILES[@]}"; do [ "$(stat -c %a "$WORKSPACE/$f")" = 644 ] || return 1; done
  if [ "$TARGET_WORKSPACE_LAYOUT" = "agents-md-tools-v1" ]; then [ ! -e "$WORKSPACE/TOOLS.md" ] || return 1; fi
}
maybe_fault(){ [ -n "$TEST_ROOT" ] && [ "${TASK_AGENT_DEPLOY_FAULT:-}" = "$1" ] && abort_deploy "TEST_FAULT_$1" "synthetic test fault" || true; }

main(){
  echo "EXECUTION_ID=$EXECUTION_ID"
  validate_source; validate_live_boundary
  if [ "$MODE" = "preflight" ]; then echo "TASK_AGENT_DEPLOY_PREFLIGHT_PASS start_is_target=$START_IS_TARGET target_taskctl=$TARGET_TASKCTL_VERSION current_taskctl=$START_TASKCTL_VERSION target_plugin=$TARGET_PLUGIN_VERSION current_plugin=$START_PLUGIN_VERSION"; exit 0; fi
  if [ "$START_IS_TARGET" -eq 1 ]; then json_result "PASS" "NOOP" "target runtime already exact; no mutation required"; echo "TASK_AGENT_DEPLOY_NOOP"; echo "RESULT_FILE=$RESULT_FILE"; exit 0; fi

  create_recovery_set || abort_deploy "BACKUP" "failed to create or validate recovery set"; maybe_fault "after-backup"
  if [ "$MATERIALIZER_ENABLED" = "1" ] && [ "$START_MATERIALIZER_EXACT" -eq 1 ]; then
    calendar_materializer_exact || abort_deploy "PREFLIGHT_OUTAGE" "existing Recurrence materializer changed after preflight"
  fi
  if [ "$REMINDER_ENABLED" = "1" ]; then reminder_dispatcher_exact || abort_deploy "PREFLIGHT_OUTAGE" "existing Reminder dispatcher changed after preflight"; fi
  if [ "$IMPORTANT_DATE_ENABLED" = "1" ]; then important_date_dispatcher_exact || abort_deploy "PREFLIGHT_OUTAGE" "existing Important Dates dispatcher changed after preflight"; fi
  systemctl_user stop openclaw-gateway.service || abort_deploy "OUTAGE" "failed to stop Gateway"; GATEWAY_STOPPED=1; maybe_fault "after-stop"
  starting_runtime_eligible || abort_deploy "PREFLIGHT_OFFLINE" "starting runtime changed after preflight"

  MUTATED=1
  if [ "$CONTACTS_ENABLED" = "1" ]; then
    install -d -m 700 "$CONTACTS_LIB" || abort_deploy "CONTACTS_INSTALL" "Contacts library directory install failed"
    install -m 600 "$CONTACTS_ROOT/core.cjs" "$CONTACTS_LIB/core.cjs" || abort_deploy "CONTACTS_INSTALL" "Contacts core install failed"
    install -m 600 "$CONTACTS_ROOT/task-store.cjs" "$CONTACTS_LIB/task-store.cjs" || abort_deploy "CONTACTS_INSTALL" "Contacts Task adapter install failed"
    install -m 700 "$CONTACTS_ROOT/contactctl" "$CONTACTCTL_TARGET" || abort_deploy "CONTACTS_INSTALL" "contactctl install failed"
    local contacts_health
    contactctl_migrate >/dev/null || abort_deploy "CONTACTS_SCHEMA_MIGRATION" "target contactctl failed to migrate Contacts database"
    contacts_health=$(contactctl_health) || abort_deploy "CONTACTS_SCHEMA_MIGRATION" "target contactctl failed to validate Contacts database"
    node -e 'const h=JSON.parse(process.argv[1]);if(h.implementation_version!==process.argv[2]||h.schema_version!==Number(process.argv[3])||h.integrity?.ok!==true)process.exit(1)' "$contacts_health" "$TARGET_CONTACTS_VERSION" "$TARGET_CONTACTS_SCHEMA" || abort_deploy "CONTACTS_SCHEMA_MIGRATION" "target Contacts generation validation failed"
    oc plugins install "$CONTACTS_PLUGIN_ARTIFACT" --force --accept-capabilities || abort_deploy "CONTACTS_PLUGIN_INSTALL" "Contacts plugin install failed"
  fi
  install -m 700 "$ROOT/taskctl" "$TASKCTL_TARGET" || abort_deploy "TASKCTL_INSTALL" "taskctl install failed"
  local migration_result migrated_health
  migration_result=$(taskctl_migrate) || abort_deploy "SCHEMA_MIGRATION" "target taskctl failed to migrate database"
  node -e 'const h=JSON.parse(process.argv[1]),v=process.argv[2],s=Number(process.argv[3]);if(h.implementation_version!==v||h.schema_version!==s)process.exit(1)' "$migration_result" "$TARGET_TASKCTL_VERSION" "$TARGET_SQLITE_SCHEMA" || abort_deploy "SCHEMA_MIGRATION" "target taskctl migration identity validation failed"
  migrated_health=$(taskctl_health) || abort_deploy "SCHEMA_MIGRATION" "target taskctl failed read-only health validation"
  node -e 'const h=JSON.parse(process.argv[1]),v=process.argv[2],s=Number(process.argv[3]);if(h.ok!==true||h.implementation_version!==v||h.schema_version!==s||h.integrity?.ok!==true)process.exit(1)' "$migrated_health" "$TARGET_TASKCTL_VERSION" "$TARGET_SQLITE_SCHEMA" || abort_deploy "SCHEMA_MIGRATION" "target taskctl/schema health validation failed"
  db_generation_exact || abort_deploy "SCHEMA_MIGRATION" "target database generation validation failed"
  maybe_fault "after-migration"
  local f; for f in "${TARGET_WORKSPACE_FILES[@]}"; do install -m 644 "$ROOT/workspace/$f" "$WORKSPACE/$f" || abort_deploy "WORKSPACE_INSTALL" "workspace install failed: $f"; done
  oc plugins install "$ARTIFACT" --force --accept-capabilities || abort_deploy "PLUGIN_INSTALL" "plugin install failed"
  oc config set "agents.entries.tasks.tools" "$TARGET_TOOLS_JSON" --strict-json || abort_deploy "TOOL_POLICY_INSTALL" "Task Agent tool policy update failed"

  validate_target || abort_deploy "OFFLINE_VALIDATE" "target offline validation failed"; maybe_fault "after-offline-validate"
  systemctl_user start openclaw-gateway.service || abort_deploy "GATEWAY_START" "failed to start Gateway"; GATEWAY_STOPPED=0
  systemctl_user is-active --quiet openclaw-gateway.service || abort_deploy "POST_RESTART" "Gateway not active after start"
  wait_gateway_rpc_ready || abort_deploy "POST_RESTART" "Gateway RPC not ready after start"
  validate_target || abort_deploy "POST_RESTART" "final target runtime validation failed"
  if [ "$MATERIALIZER_ENABLED" = "1" ]; then calendar_materializer_exact || abort_deploy "CALENDAR_MATERIALIZER" "Recurrence materializer drifted during deployment"; fi
  if [ "$REMINDER_ENABLED" = "1" ]; then reminder_dispatcher_exact || abort_deploy "REMINDER_DISPATCHER" "Reminder dispatcher drifted during deployment"; fi
  if [ "$IMPORTANT_DATE_ENABLED" = "1" ]; then important_date_dispatcher_exact || abort_deploy "IMPORTANT_DATE_DISPATCHER" "Important Dates dispatcher drifted during deployment"; fi

  json_result "PASS" "COMPLETE" "Task Agent taskctl $TARGET_TASKCTL_VERSION / plugin $TARGET_PLUGIN_VERSION deployment completed"; echo "TASK_AGENT_DEPLOY_PASS"; echo "RESULT_FILE=$RESULT_FILE"
}
main
