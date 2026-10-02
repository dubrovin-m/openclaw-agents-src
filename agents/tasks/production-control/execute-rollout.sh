#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "$#" -ne 4 ]; then
  echo "Usage: $0 <request-id> <source-checkout> <controller-state-dir> <expected-openclaw-version>" >&2
  exit 2
fi

REQUEST_ID=$1
SOURCE_DIR=$2
STATE_DIR=$3
EXPECTED_OPENCLAW_VERSION=$4

[[ "$REQUEST_ID" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid request id" >&2; exit 2; }
case "$SOURCE_DIR" in /*) ;; *) echo "Source checkout must be absolute" >&2; exit 2;; esac
case "$STATE_DIR" in /*) ;; *) echo "Controller state directory must be absolute" >&2; exit 2;; esac
[[ "$EXPECTED_OPENCLAW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid expected OpenClaw predecessor version" >&2; exit 2; }

for cmd in node git mkdir chmod mktemp find awk date wc tail mv rm sha256sum df sleep; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Required command unavailable: $cmd" >&2; exit 2; }
done

RUNTIME_CONTRACT="$SOURCE_DIR/runtime-contract.json"
RUNTIME_HELPER="$SOURCE_DIR/shared/runtime-contract/runtime-contract.mjs"
SPECIALIZED_ACCEPTANCE="$SOURCE_DIR/agents/tasks/production-control/specialized-agent-acceptance.mjs"
DEPLOY="$SOURCE_DIR/agents/tasks/deploy.sh"
TASK_TOOLS="$SOURCE_DIR/agents/tasks/config/tasks-tools.json"
MAIN_CONTACTS_TOOLS="$SOURCE_DIR/agents/tasks/config/main-contacts-tools.json"
TASK_RELEASE="$SOURCE_DIR/agents/tasks/release.json"
RETENTION_LIB="${BASH_SOURCE[0]%/*}/lib.mjs"
[ -f "$RUNTIME_CONTRACT" ] && [ -f "$RUNTIME_HELPER" ] || { echo "Frozen runtime requirements or qualification helper are unavailable" >&2; exit 2; }
[ -f "$SPECIALIZED_ACCEPTANCE" ] || { echo "Frozen specialized-agent acceptance probe is unavailable" >&2; exit 2; }
[ -x "$DEPLOY" ] || { echo "Frozen Task deploy entrypoint is unavailable or not executable" >&2; exit 2; }
[ -f "$TASK_TOOLS" ] && [ -f "$TASK_RELEASE" ] || { echo "Frozen Task staging policy or release metadata is unavailable" >&2; exit 2; }
[ -f "$RETENTION_LIB" ] || { echo "Installed production-control retention library is unavailable" >&2; exit 2; }
[ -z "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=all)" ] || { echo "Frozen rollout source checkout is dirty" >&2; exit 2; }
SOURCE_REVISION=$(git -C "$SOURCE_DIR" rev-parse HEAD)
[[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "Cannot establish exact rollout source revision" >&2; exit 2; }
TASK_STAGE_ALLOWANCE=$(node - "$TASK_TOOLS" "$MAIN_CONTACTS_TOOLS" "$TASK_RELEASE" <<'NODE'
const fs=require('fs');
const readObject=(path,label)=>{const value=JSON.parse(fs.readFileSync(path,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} is invalid`);return value;};
const taskTools=readObject(process.argv[2],'Task tools');
const mainContactsToolsPath=process.argv[3];
const release=readObject(process.argv[4],'Task release');
if(release.format!=='task-agent-release-v2'||release?.plugin?.name!=='openclaw-plugin-taskctl')process.exit(2);
const mutable=['taskctl'];
const targetPolicies={tasks:taskTools};
if(Object.prototype.hasOwnProperty.call(release,'shared_contacts')){
  if(!release.shared_contacts||typeof release.shared_contacts!=='object'||Array.isArray(release.shared_contacts)||typeof release.shared_contacts.release_path!=='string'||release.shared_contacts.release_path.trim()==='')process.exit(2);
  mutable.push('contacts');
  targetPolicies.main=readObject(mainContactsToolsPath,'Main Contacts tools');
}
process.stdout.write(JSON.stringify({mutable_plugin_ids:mutable,target_agent_tool_policies:targetPolicies}));
NODE
) || { echo "Frozen Task staging allowance is invalid" >&2; exit 2; }

TARGET_OPENCLAW_VERSION=$(node "$RUNTIME_HELPER" openclaw-version "$RUNTIME_CONTRACT") || { echo "Invalid frozen OpenClaw qualification target" >&2; exit 2; }

[ "$TARGET_OPENCLAW_VERSION" != "$EXPECTED_OPENCLAW_VERSION" ] || { echo "Rollout target does not change OpenClaw version" >&2; exit 2; }
if ! node - "$TARGET_OPENCLAW_VERSION" "$EXPECTED_OPENCLAW_VERSION" <<'NODE'
const a=process.argv[2].split('.').map(Number),b=process.argv[3].split('.').map(Number);
if(a.length!==3||b.length!==3||a.some(x=>!Number.isInteger(x))||b.some(x=>!Number.isInteger(x)))process.exit(2);
for(let i=0;i<3;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1);}process.exit(1);
NODE
then
  echo "Rollout target must be newer than the expected production OpenClaw version" >&2
  exit 2
fi

DEPLOY_PATH="$HOME/.npm-global/bin${PATH:+:$PATH}"
export PATH="$DEPLOY_PATH"
OPENCLAW_BIN=$(command -v openclaw || true)
[ -n "$OPENCLAW_BIN" ] || { echo "Required command unavailable: openclaw" >&2; exit 2; }

EXEC_DIR="$STATE_DIR/executions"
RECOVERY_PARENT="$STATE_DIR/recovery"
RECOVERY_DIR="$RECOVERY_PARENT/request-$REQUEST_ID"
mkdir -p "$EXEC_DIR" "$RECOVERY_DIR"
chmod 700 "$STATE_DIR" "$EXEC_DIR" "$RECOVERY_PARENT" "$RECOVERY_DIR" 2>/dev/null || true
LOG="$EXEC_DIR/request-$REQUEST_ID-rollout.log"
RESULT="$EXEC_DIR/request-$REQUEST_ID.json"
TMP_RESULT="$RESULT.tmp.$$"
: > "$LOG"
chmod 600 "$LOG"

OUTCOME="BLOCKED_REQUIRES_JUDGMENT"
BLOCK_FURTHER=false
STAGE="PREFLIGHT"
REASON=""
MUTATION_STARTED=false
BACKUP_CREATED=false
BACKUP_ARCHIVE=""
BACKUP_SHA256=""
CORE_VERSION="$EXPECTED_OPENCLAW_VERSION"
GATEWAY_READY=false
CODEX_VERSION=""
SPECIALIZED_BASELINE=""
SPECIALIZED_PRECHECK=false
SPECIALIZED_CORE_ACCEPTANCE=false
SPECIALIZED_FINAL_ACCEPTANCE=false
PREDEPLOY_RESULT=""
PREDEPLOY_STAGE=""
PREDEPLOY_MUTATION_STARTED=false
TASK_DEPLOY_RESULT=""
TASK_DEPLOY_STAGE=""
TASK_MUTATION_STARTED=false
UPDATE_RUN_ID=""
UPDATE_RUN_STATUS=""
UPDATE_RUN_RECONCILED=false
UPDATE_RUN_UNSAFE=false
UPDATE_COMMAND_EXIT=""

write_result() {
  REQUEST_ID_ENV="$REQUEST_ID" OUTCOME_ENV="$OUTCOME" BLOCK_ENV="$BLOCK_FURTHER" \
  STAGE_ENV="$STAGE" REASON_ENV="$REASON" SOURCE_REVISION_ENV="$SOURCE_REVISION" \
  PREDECESSOR_ENV="$EXPECTED_OPENCLAW_VERSION" TARGET_ENV="$TARGET_OPENCLAW_VERSION" \
  MUTATION_ENV="$MUTATION_STARTED" BACKUP_ENV="$BACKUP_CREATED" BACKUP_ARCHIVE_ENV="$BACKUP_ARCHIVE" BACKUP_SHA256_ENV="$BACKUP_SHA256" CORE_ENV="$CORE_VERSION" \
  GATEWAY_ENV="$GATEWAY_READY" CODEX_ENV="$CODEX_VERSION" SPECIALIZED_BASELINE_ENV="$SPECIALIZED_BASELINE" \
  SPECIALIZED_PRECHECK_ENV="$SPECIALIZED_PRECHECK" SPECIALIZED_CORE_ENV="$SPECIALIZED_CORE_ACCEPTANCE" SPECIALIZED_FINAL_ENV="$SPECIALIZED_FINAL_ACCEPTANCE" \
  PREDEPLOY_RESULT_ENV="$PREDEPLOY_RESULT" PREDEPLOY_STAGE_ENV="$PREDEPLOY_STAGE" PREDEPLOY_MUTATION_ENV="$PREDEPLOY_MUTATION_STARTED" TASK_RESULT_ENV="$TASK_DEPLOY_RESULT" \
  TASK_STAGE_ENV="$TASK_DEPLOY_STAGE" TASK_MUTATION_ENV="$TASK_MUTATION_STARTED" \
  UPDATE_RUN_ID_ENV="$UPDATE_RUN_ID" UPDATE_RUN_STATUS_ENV="$UPDATE_RUN_STATUS" UPDATE_RUN_RECONCILED_ENV="$UPDATE_RUN_RECONCILED" UPDATE_COMMAND_EXIT_ENV="$UPDATE_COMMAND_EXIT" \
  node - "$TMP_RESULT" <<'NODE'
const fs=require('fs');
const bool=(name)=>process.env[name]==='true';
let specialized=null;
if(process.env.SPECIALIZED_BASELINE_ENV){try{specialized=JSON.parse(process.env.SPECIALIZED_BASELINE_ENV);}catch{}}
const out={
  request_id:Number(process.env.REQUEST_ID_ENV),
  outcome:process.env.OUTCOME_ENV,
  block_further_deployments:bool('BLOCK_ENV'),
  stage:process.env.STAGE_ENV,
  reason:process.env.REASON_ENV||null,
  source_revision:process.env.SOURCE_REVISION_ENV,
  predecessor_openclaw_version:process.env.PREDECESSOR_ENV,
  target_openclaw_version:process.env.TARGET_ENV,
  mutation_started:bool('MUTATION_ENV'),
  backup_created:bool('BACKUP_ENV'),
  backup_archive:process.env.BACKUP_ARCHIVE_ENV||null,
  backup_sha256:process.env.BACKUP_SHA256_ENV||null,
  core_version:process.env.CORE_ENV||null,
  gateway_ready:bool('GATEWAY_ENV'),
  codex_version:process.env.CODEX_ENV||null,
  specialized_runtime_precheck:bool('SPECIALIZED_PRECHECK_ENV'),
  specialized_core_acceptance:bool('SPECIALIZED_CORE_ENV'),
  specialized_final_acceptance:bool('SPECIALIZED_FINAL_ENV'),
  specialized_agent_ids:Array.isArray(specialized?.agent_ids)?specialized.agent_ids:null,
  specialized_external_plugin_ids:Array.isArray(specialized?.external_plugin_ids)?specialized.external_plugin_ids:null,
  task_predeploy_result:process.env.PREDEPLOY_RESULT_ENV||null,
  task_predeploy_stage:process.env.PREDEPLOY_STAGE_ENV||null,
  task_predeploy_mutation_started:bool('PREDEPLOY_MUTATION_ENV'),
  task_deploy_result:process.env.TASK_RESULT_ENV||null,
  task_deploy_stage:process.env.TASK_STAGE_ENV||null,
  task_mutation_started:bool('TASK_MUTATION_ENV'),
  update_run_id:process.env.UPDATE_RUN_ID_ENV||null,
  update_run_status:process.env.UPDATE_RUN_STATUS_ENV||null,
  update_run_reconciled:bool('UPDATE_RUN_RECONCILED_ENV'),
  update_command_exit:process.env.UPDATE_COMMAND_EXIT_ENV===''?null:Number(process.env.UPDATE_COMMAND_EXIT_ENV),
  completed_at:new Date().toISOString(),
};
fs.writeFileSync(process.argv[2],JSON.stringify(out,null,2)+'\n',{mode:0o600});
NODE
  mv -f "$TMP_RESULT" "$RESULT"
  chmod 600 "$RESULT"
}

finish() {
  write_result
  printf 'RESULT_FILE=%s\n' "$RESULT"
  if [ "$OUTCOME" = "SUCCESS" ]; then exit 0; fi
  if [ "$OUTCOME" = "RECOVERY_REQUIRED" ] || [ "$OUTCOME" = "UNKNOWN" ]; then exit 2; fi
  exit 1
}

read_openclaw_version() {
  "$OPENCLAW_BIN" --version 2>>"$LOG" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=/(?:^|\s)([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/u.exec(s.trim());if(!m)process.exit(2);process.stdout.write(m[1]);});'
}

gateway_health() {
  local file code
  file=$(mktemp "$EXEC_DIR/health-$REQUEST_ID.XXXXXX")
  chmod 600 "$file"
  set +e
  "$OPENCLAW_BIN" gateway health --json >"$file" 2>>"$LOG"
  code=$?
  set -e
  rm -f "$file"
  [ "$code" -eq 0 ]
}

specialized_runtime_accepts() {
  node "$SPECIALIZED_ACCEPTANCE" accept "$OPENCLAW_BIN" "$SPECIALIZED_BASELINE" >>"$LOG" 2>&1
}

# The OpenClaw CLI may hand an admitted update to a detached managed-service
# owner and return before that durable run finishes. Reconcile against the
# public update ledger instead of treating the foreground process exit as the
# update outcome.
UPDATE_RUN_MAX_POLLS=120
UPDATE_RUN_POLL_SECONDS=5
reconcile_update_run() {
  local update_result_file=$1
  local explicit_run_id attempt=0 status_file status_exit fields parse_exit run_id phase status after_version restart_safe
  explicit_run_id=$(node - "$update_result_file" <<'NODE'
const fs=require('fs');let v={};try{v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));}catch{}
const id=v?.runId??v?.run?.runId??v?.result?.runId??null;
if(typeof id==='string')process.stdout.write(id);
NODE
  )
  [ -n "$explicit_run_id" ] || return 3
  while [ "$attempt" -lt "$UPDATE_RUN_MAX_POLLS" ]; do
    status_file=$(mktemp "$EXEC_DIR/update-ledger-$REQUEST_ID.XXXXXX")
    chmod 600 "$status_file"
    if "$OPENCLAW_BIN" update status --json --timeout 10 >"$status_file" 2>>"$LOG"; then status_exit=0; else status_exit=$?; fi
    if [ "$status_exit" -eq 0 ]; then
      if fields=$(EXPLICIT_ENV="$explicit_run_id" TARGET_ENV="$TARGET_OPENCLAW_VERSION" EXPECTED_ENV="$EXPECTED_OPENCLAW_VERSION" node - "$status_file" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const explicit=process.env.EXPLICIT_ENV;const target=process.env.TARGET_ENV;const expected=process.env.EXPECTED_ENV;
const candidates=[v?.activeRun,v?.lastRun].filter(x=>x&&typeof x==='object');
const run=candidates.find((r)=>{
  if(typeof r.runId!=='string'||r.runId!==explicit)return false;
  if(r?.target?.version!==target)return false;
  if(r?.before?.version&&r.before.version!==expected)return false;
  return true;
});
if(!run)process.exit(3);
const safe=run?.recovery?.serviceRestartSafe??run?.verification?.recovery?.serviceRestartSafe;
const values=[run.runId,run.phase??'',run.status??'',run?.after?.version??'',safe===false?'false':safe===true?'true':''];
process.stdout.write(values.join('\x1f'));
NODE
      ); then parse_exit=0; else parse_exit=$?; fi
      if [ "$parse_exit" -eq 0 ]; then
        IFS=$'\x1f' read -r run_id phase status after_version restart_safe <<<"$fields"
        UPDATE_RUN_ID="$run_id"
        if [ "$phase" = "finished" ]; then
          UPDATE_RUN_STATUS="$status"
          UPDATE_RUN_RECONCILED=true
          rm -f "$status_file"
          if [ "$restart_safe" = false ]; then
            UPDATE_RUN_UNSAFE=true
            return 4
          fi
          if [ "$status" = "succeeded" ] && [ "$after_version" = "$TARGET_OPENCLAW_VERSION" ]; then
            return 0
          fi
          return 1
        fi
      fi
    fi
    rm -f "$status_file"
    attempt=$((attempt+1))
    if [ "$attempt" -lt "$UPDATE_RUN_MAX_POLLS" ]; then sleep "$UPDATE_RUN_POLL_SECONDS"; fi
  done
  return 2
}

MIN_FREE_KB=2097152
disk_headroom_ok() {
  local path available
  for path in "$HOME" "${TMPDIR:-/tmp}" "$STATE_DIR"; do
    available=$(df -Pk "$path" 2>>"$LOG" | awk 'NR==2 {print $4}')
    [[ "$available" =~ ^[0-9]+$ ]] || return 1
    if [ "$available" -lt "$MIN_FREE_KB" ]; then
      printf 'disk headroom insufficient path=%s available_kb=%s required_kb=%s\n' "$path" "$available" "$MIN_FREE_KB" >>"$LOG"
      return 1
    fi
  done
  return 0
}

run_task_deploy() {
  local phase=$1 log_start task_exit result_file fields result stage mutated
  log_start=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  set +e
  PATH="$DEPLOY_PATH" "$DEPLOY" --apply >>"$LOG" 2>&1
  task_exit=$?
  set -e
  result_file=$(tail -n "+$((log_start+1))" "$LOG" | awk -F= '/^RESULT_FILE=/{v=$2} END{print v}')
  if [ -z "$result_file" ] || [ ! -f "$result_file" ]; then
    OUTCOME="UNKNOWN"; BLOCK_FURTHER=true; STAGE="$phase"; REASON="$phase did not publish durable Task result evidence"; finish
  fi
  fields=$(node - "$result_file" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));process.stdout.write(`${v?.result??''}\t${v?.stage??''}\t${v?.mutation_started===true?'true':'false'}`);
NODE
  ) || { OUTCOME="UNKNOWN"; BLOCK_FURTHER=true; STAGE="$phase"; REASON="$phase Task result evidence is unreadable"; finish; }
  IFS=$'\t' read -r result stage mutated <<<"$fields"
  if [ "$phase" = "TASK_PREDEPLOY" ]; then
    PREDEPLOY_RESULT="$result"; PREDEPLOY_STAGE="$stage"; PREDEPLOY_MUTATION_STARTED="$mutated"
  else
    TASK_DEPLOY_RESULT="$result"; TASK_DEPLOY_STAGE="$stage"; TASK_MUTATION_STARTED="$mutated"
  fi
  if [ "$mutated" = true ]; then MUTATION_STARTED=true; fi
  if [ "$task_exit" -ne 0 ] || [ "$result" != "PASS" ]; then
    STAGE="$phase"; BLOCK_FURTHER=true
    if [ "$result" = "BLOCKED" ] && [ "$mutated" = true ]; then OUTCOME="RECOVERY_REQUIRED"; REASON="$phase failed without a proven Task rollback"; else OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; REASON="$phase did not complete the frozen Task target"; fi
    finish
  fi
}

if ! disk_headroom_ok; then
  REASON="Insufficient free disk space for OpenClaw rollout; at least 2 GiB is required on runtime, temp, and controller-state filesystems"
  finish
fi

STATUS_JSON=$(mktemp "$EXEC_DIR/update-status-$REQUEST_ID.XXXXXX")
chmod 600 "$STATUS_JSON"
set +e
"$OPENCLAW_BIN" update status --json --timeout 10 >"$STATUS_JSON" 2>>"$LOG"
STATUS_EXIT=$?
set -e
if [ "$STATUS_EXIT" -ne 0 ]; then rm -f "$STATUS_JSON"; REASON="OpenClaw update status probe failed"; finish; fi
if ! node - "$STATUS_JSON" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const ok=v?.channel?.value==='stable'&&v?.update?.installKind==='package'&&!v?.activeRun;
if(!ok)process.exit(2);
NODE
then rm -f "$STATUS_JSON"; REASON="Production update state is not an idle stable package installation"; finish; fi
rm -f "$STATUS_JSON"
CORE_VERSION=$(read_openclaw_version 2>/dev/null || true)
[ "$CORE_VERSION" = "$EXPECTED_OPENCLAW_VERSION" ] || { REASON="Shell OpenClaw version does not match the qualified predecessor"; finish; }

DRY_JSON=$(mktemp "$EXEC_DIR/update-dry-$REQUEST_ID.XXXXXX")
chmod 600 "$DRY_JSON"
set +e
"$OPENCLAW_BIN" update --tag "$TARGET_OPENCLAW_VERSION" --dry-run --json >"$DRY_JSON" 2>>"$LOG"
DRY_EXIT=$?
set -e
if [ "$DRY_EXIT" -ne 0 ]; then rm -f "$DRY_JSON"; REASON="Exact-target OpenClaw dry-run failed"; finish; fi
if ! TARGET_ENV="$TARGET_OPENCLAW_VERSION" EXPECTED_ENV="$EXPECTED_OPENCLAW_VERSION" node - "$DRY_JSON" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const ok=v?.dryRun===true&&v?.installKind==='package'&&v?.updateInstallKind==='package'&&v?.switchToGit===false&&v?.switchToPackage===false&&v?.effectiveChannel==='stable'&&v?.currentVersion===process.env.EXPECTED_ENV&&v?.targetVersion===process.env.TARGET_ENV&&v?.downgradeRisk===false&&v?.restart===true;
if(!ok)process.exit(2);
NODE
then rm -f "$DRY_JSON"; REASON="Exact-target OpenClaw dry-run did not prove the frozen rollout plan"; finish; fi
rm -f "$DRY_JSON"

if ! SPECIALIZED_BASELINE=$(node "$SPECIALIZED_ACCEPTANCE" snapshot "$OPENCLAW_BIN" 2>>"$LOG"); then
  REASON="Current specialized-agent runtime did not pass deterministic pre-upgrade acceptance"
  finish
fi
SPECIALIZED_PRECHECK=true

BACKUP_JSON=$(mktemp "$EXEC_DIR/backup-$REQUEST_ID.XXXXXX")
chmod 600 "$BACKUP_JSON"
set +e
"$OPENCLAW_BIN" backup create --output "$RECOVERY_DIR" --verify --json >"$BACKUP_JSON" 2>>"$LOG"
BACKUP_EXIT=$?
set -e
rm -f "$BACKUP_JSON"
if [ "$BACKUP_EXIT" -ne 0 ]; then REASON="Verified pre-update OpenClaw backup failed"; finish; fi
mapfile -t BACKUP_ARCHIVES < <(find "$RECOVERY_DIR" -maxdepth 1 -type f -name '*.tar.gz' -print)
if [ "${#BACKUP_ARCHIVES[@]}" -ne 1 ]; then REASON="Verified pre-update OpenClaw backup artifact is not unique"; finish; fi
BACKUP_ARCHIVE="${BACKUP_ARCHIVES[0]}"
chmod go-rwx "$BACKUP_ARCHIVE" 2>/dev/null || true
BACKUP_SHA256=$(sha256sum "$BACKUP_ARCHIVE" | awk '{print $1}')
[[ "$BACKUP_SHA256" =~ ^[0-9a-f]{64}$ ]] || { REASON="Verified pre-update OpenClaw backup checksum is invalid"; finish; }
BACKUP_CREATED=true

if ! RETENTION_RESULT=$(node - "$RETENTION_LIB" "$RECOVERY_PARENT" "$BACKUP_ARCHIVE" <<'NODE'
const { pathToFileURL }=require('node:url');
(async()=>{
  const mod=await import(pathToFileURL(process.argv[2]).href);
  const result=mod.pruneSupersededRolloutBackups(process.argv[3],process.argv[4]);
  process.stdout.write(JSON.stringify(result));
})().catch((error)=>{console.error(error?.message||String(error));process.exit(1);});
NODE
); then
  REASON="Superseded rollout recovery backup pruning failed"
  finish
fi
printf 'recovery retention %s\n' "$RETENTION_RESULT" >>"$LOG"

if ! disk_headroom_ok; then
  REASON="Insufficient free disk space for OpenClaw mutation after backup; at least 2 GiB is required"
  finish
fi

# Stage plugins while the predecessor host is still active. The frozen plugin API range
# must include both the predecessor and target hosts, so either side of the core update
# remains recoverable.
run_task_deploy "TASK_PREDEPLOY"
CORE_VERSION=$(read_openclaw_version 2>/dev/null || true)
if [ "$CORE_VERSION" != "$EXPECTED_OPENCLAW_VERSION" ] || ! gateway_health; then
  GATEWAY_READY=false; OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="TASK_PREDEPLOY_ACCEPTANCE"; REASON="Pre-update Task staging did not preserve a healthy predecessor OpenClaw runtime"; finish
fi
GATEWAY_READY=true
if ! STAGED_SPECIALIZED_BASELINE=$(node "$SPECIALIZED_ACCEPTANCE" stage "$OPENCLAW_BIN" "$SPECIALIZED_BASELINE" "$TASK_STAGE_ALLOWANCE" 2>>"$LOG"); then
  BLOCK_FURTHER=true; STAGE="TASK_PREDEPLOY_ACCEPTANCE"; REASON="Pre-update Task staging changed specialized-agent state outside the frozen Task staging allowance"
  if [ "$MUTATION_STARTED" = true ]; then OUTCOME="RECOVERY_REQUIRED"; else OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; fi
  finish
fi
SPECIALIZED_BASELINE="$STAGED_SPECIALIZED_BASELINE"
if ! disk_headroom_ok; then
  OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; BLOCK_FURTHER=true; STAGE="TASK_PREDEPLOY_ACCEPTANCE"; REASON="Insufficient disk headroom after Task plugin staging; staged compatible plugins remain active and reconciliation is required"; finish
fi

UPDATE_JSON=$(mktemp "$EXEC_DIR/update-$REQUEST_ID.XXXXXX")
chmod 600 "$UPDATE_JSON"
MUTATION_STARTED=true
set +e
"$OPENCLAW_BIN" update --tag "$TARGET_OPENCLAW_VERSION" --json >"$UPDATE_JSON" 2>>"$LOG"
UPDATE_EXIT=$?
set -e
UPDATE_COMMAND_EXIT="$UPDATE_EXIT"
UPDATE_UNSAFE=false
if node - "$UPDATE_JSON" <<'NODE'
const fs=require('fs');let v;try{v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));}catch{process.exit(2);}process.exit(v?.recovery?.serviceRestartSafe===false?0:1);
NODE
then UPDATE_UNSAFE=true; fi
UPDATE_ACCEPTED=false
if [ "$UPDATE_EXIT" -eq 0 ] && TARGET_ENV="$TARGET_OPENCLAW_VERSION" node - "$UPDATE_JSON" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(v?.status!=='ok'||(v?.after?.version&&v.after.version!==process.env.TARGET_ENV)||v?.recovery?.serviceRestartSafe===false||v?.postUpdate?.plugins?.status==='error')process.exit(2);
NODE
then
  UPDATE_ACCEPTED=true
else
  if [ "$UPDATE_UNSAFE" = true ]; then
    rm -f "$UPDATE_JSON"
    OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="OPENCLAW_UPDATE"; REASON="OpenClaw update reported that managed service restart is unsafe"; finish
  fi
  if reconcile_update_run "$UPDATE_JSON"; then RECONCILE_EXIT=0; else RECONCILE_EXIT=$?; fi
  if [ "$RECONCILE_EXIT" -eq 0 ]; then
    UPDATE_ACCEPTED=true
  elif [ "$RECONCILE_EXIT" -eq 2 ]; then
    rm -f "$UPDATE_JSON"
    OUTCOME="UNKNOWN"; BLOCK_FURTHER=true; STAGE="OPENCLAW_UPDATE"; REASON="OpenClaw update outcome did not become terminal in the durable run ledger"; finish
  elif [ "$RECONCILE_EXIT" -eq 3 ]; then
    rm -f "$UPDATE_JSON"
    OUTCOME="UNKNOWN"; BLOCK_FURTHER=true; STAGE="OPENCLAW_UPDATE"; REASON="OpenClaw updater did not identify the exact durable update run after mutation started"; finish
  elif [ "$RECONCILE_EXIT" -eq 4 ] || [ "$UPDATE_RUN_UNSAFE" = true ]; then
    rm -f "$UPDATE_JSON"
    OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="OPENCLAW_UPDATE"; REASON="OpenClaw durable update run reported that managed service restart is unsafe"; finish
  fi
fi
rm -f "$UPDATE_JSON"
if [ "$UPDATE_ACCEPTED" != true ]; then
  CORE_VERSION=$(read_openclaw_version 2>/dev/null || true)
  if gateway_health; then GATEWAY_READY=true; else GATEWAY_READY=false; fi
  STAGE="OPENCLAW_UPDATE"; BLOCK_FURTHER=true
  if [ "$CORE_VERSION" != "$EXPECTED_OPENCLAW_VERSION" ] || [ "$GATEWAY_READY" != true ]; then
    OUTCOME="RECOVERY_REQUIRED"; REASON="OpenClaw durable update run failed without a proven healthy predecessor runtime"
  else
    OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; REASON="OpenClaw durable update run failed; predecessor runtime remains healthy"
  fi
  finish
fi

CORE_VERSION=$(read_openclaw_version 2>/dev/null || true)
if [ "$CORE_VERSION" != "$TARGET_OPENCLAW_VERSION" ]; then OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="OPENCLAW_ACCEPTANCE"; REASON="Installed OpenClaw version does not match the frozen target"; finish; fi
if gateway_health; then GATEWAY_READY=true; else GATEWAY_READY=false; fi
if [ "$GATEWAY_READY" != true ]; then OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="OPENCLAW_ACCEPTANCE"; REASON="Gateway health RPC did not recover after the OpenClaw update"; finish; fi
if specialized_runtime_accepts; then
  SPECIALIZED_CORE_ACCEPTANCE=true
else
  OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="SPECIALIZED_CORE_ACCEPTANCE"; REASON="Specialized-agent runtime health or identity changed after the OpenClaw update"; finish
fi

CODEX_EXPECTED=$(node -e 'const v=process.argv[1],m=/^([0-9]+\.[0-9]+\.[0-9]+)-[0-9]+$/u.exec(v);process.stdout.write(m?m[1]:v);' "$TARGET_OPENCLAW_VERSION")
CODEX_JSON=$(mktemp "$EXEC_DIR/codex-$REQUEST_ID.XXXXXX")
chmod 600 "$CODEX_JSON"
set +e
"$OPENCLAW_BIN" plugins inspect codex --runtime --json >"$CODEX_JSON" 2>>"$LOG"
CODEX_EXIT=$?
set -e
if [ "$CODEX_EXIT" -ne 0 ]; then rm -f "$CODEX_JSON"; OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; BLOCK_FURTHER=true; STAGE="CODEX_ACCEPTANCE"; REASON="Codex runtime inspection failed after the OpenClaw update"; finish; fi
CODEX_VERSION=$(node - "$CODEX_JSON" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));process.stdout.write(typeof v?.plugin?.version==='string'?v.plugin.version:'');
NODE
)
if ! CODEX_EXPECTED_ENV="$CODEX_EXPECTED" node - "$CODEX_JSON" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const c=Array.isArray(v?.compatibility)?v.compatibility:[];
if(v?.plugin?.id!=='codex'||v?.plugin?.status!=='loaded'||v?.plugin?.version!==process.env.CODEX_EXPECTED_ENV||c.length!==0||(v?.install?.version&&v.install.version!==process.env.CODEX_EXPECTED_ENV))process.exit(2);
NODE
then rm -f "$CODEX_JSON"; OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; BLOCK_FURTHER=true; STAGE="CODEX_ACCEPTANCE"; REASON="Codex runtime did not converge to the qualified OpenClaw release cohort"; finish; fi
rm -f "$CODEX_JSON"

run_task_deploy "TASK_ACCEPTANCE"

CORE_VERSION=$(read_openclaw_version 2>/dev/null || true)
if [ "$CORE_VERSION" != "$TARGET_OPENCLAW_VERSION" ] || ! gateway_health; then GATEWAY_READY=false; OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="FINAL_ACCEPTANCE"; REASON="Final OpenClaw/Gateway acceptance failed after Task deployment"; finish; fi
GATEWAY_READY=true
FINAL_CODEX_JSON=$(mktemp "$EXEC_DIR/codex-final-$REQUEST_ID.XXXXXX")
chmod 600 "$FINAL_CODEX_JSON"
set +e
"$OPENCLAW_BIN" plugins inspect codex --runtime --json >"$FINAL_CODEX_JSON" 2>>"$LOG"
FINAL_CODEX_EXIT=$?
set -e
if [ "$FINAL_CODEX_EXIT" -ne 0 ] || ! CODEX_EXPECTED_ENV="$CODEX_EXPECTED" node - "$FINAL_CODEX_JSON" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(v?.plugin?.id!=='codex'||v?.plugin?.status!=='loaded'||v?.plugin?.version!==process.env.CODEX_EXPECTED_ENV||(Array.isArray(v?.compatibility)&&v.compatibility.length>0))process.exit(2);
NODE
then rm -f "$FINAL_CODEX_JSON"; OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; BLOCK_FURTHER=true; STAGE="FINAL_ACCEPTANCE"; REASON="Final Codex acceptance failed after Task deployment"; finish; fi
CODEX_VERSION=$(node - "$FINAL_CODEX_JSON" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));process.stdout.write(v.plugin.version);
NODE
)
rm -f "$FINAL_CODEX_JSON"
if specialized_runtime_accepts; then
  SPECIALIZED_FINAL_ACCEPTANCE=true
else
  OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="FINAL_ACCEPTANCE"; REASON="Final specialized-agent runtime acceptance failed after Task deployment"; finish
fi

OUTCOME="SUCCESS"
BLOCK_FURTHER=false
STAGE="COMPLETE"
REASON=""
finish
