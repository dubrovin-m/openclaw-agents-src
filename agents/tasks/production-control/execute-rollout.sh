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

for cmd in node git mkdir chmod mktemp find awk date wc tail mv rm sha256sum df; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Required command unavailable: $cmd" >&2; exit 2; }
done

RUNTIME_CONTRACT="$SOURCE_DIR/runtime-contract.json"
DEPLOY="$SOURCE_DIR/agents/tasks/deploy.sh"
[ -f "$RUNTIME_CONTRACT" ] || { echo "Frozen runtime contract is unavailable" >&2; exit 2; }
[ -x "$DEPLOY" ] || { echo "Frozen Task deploy entrypoint is unavailable or not executable" >&2; exit 2; }
[ -z "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=all)" ] || { echo "Frozen rollout source checkout is dirty" >&2; exit 2; }
SOURCE_REVISION=$(git -C "$SOURCE_DIR" rev-parse HEAD)
[[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "Cannot establish exact rollout source revision" >&2; exit 2; }

TARGET_OPENCLAW_VERSION=$(node - "$RUNTIME_CONTRACT" <<'NODE'
const fs = require('fs');
const contract = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (contract?.format !== 'openclaw-agents-runtime-contract-v1') process.exit(2);
const value = contract?.openclaw?.version;
if (typeof value !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value)) process.exit(2);
process.stdout.write(value);
NODE
) || { echo "Invalid frozen runtime contract" >&2; exit 2; }

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
TASK_DEPLOY_RESULT=""
TASK_DEPLOY_STAGE=""
TASK_MUTATION_STARTED=false

write_result() {
  REQUEST_ID_ENV="$REQUEST_ID" OUTCOME_ENV="$OUTCOME" BLOCK_ENV="$BLOCK_FURTHER" \
  STAGE_ENV="$STAGE" REASON_ENV="$REASON" SOURCE_REVISION_ENV="$SOURCE_REVISION" \
  PREDECESSOR_ENV="$EXPECTED_OPENCLAW_VERSION" TARGET_ENV="$TARGET_OPENCLAW_VERSION" \
  MUTATION_ENV="$MUTATION_STARTED" BACKUP_ENV="$BACKUP_CREATED" BACKUP_ARCHIVE_ENV="$BACKUP_ARCHIVE" BACKUP_SHA256_ENV="$BACKUP_SHA256" CORE_ENV="$CORE_VERSION" \
  GATEWAY_ENV="$GATEWAY_READY" CODEX_ENV="$CODEX_VERSION" TASK_RESULT_ENV="$TASK_DEPLOY_RESULT" \
  TASK_STAGE_ENV="$TASK_DEPLOY_STAGE" TASK_MUTATION_ENV="$TASK_MUTATION_STARTED" \
  node - "$TMP_RESULT" <<'NODE'
const fs=require('fs');
const bool=(name)=>process.env[name]==='true';
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
  task_deploy_result:process.env.TASK_RESULT_ENV||null,
  task_deploy_stage:process.env.TASK_STAGE_ENV||null,
  task_mutation_started:bool('TASK_MUTATION_ENV'),
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

if ! disk_headroom_ok; then
  REASON="Insufficient free disk space for OpenClaw rollout; at least 2 GiB is required on runtime, temp, and controller-state filesystems"
  finish
fi

STATUS_JSON=$(mktemp "$EXEC_DIR/update-status-$REQUEST_ID.XXXXXX")
chmod 600 "$STATUS_JSON"
set +e
"$OPENCLAW_BIN" gateway call update.status --json >"$STATUS_JSON" 2>>"$LOG"
STATUS_EXIT=$?
set -e
if [ "$STATUS_EXIT" -ne 0 ]; then rm -f "$STATUS_JSON"; REASON="OpenClaw update status probe failed"; finish; fi
if ! EXPECTED_ENV="$EXPECTED_OPENCLAW_VERSION" node - "$STATUS_JSON" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const ok=v?.effectiveChannel==='stable'&&v?.schedule?.channel==='stable'&&v?.schedule?.target?.kind==='package'&&v?.updateAvailable?.currentVersion===process.env.EXPECTED_ENV;
if(!ok)process.exit(2);
NODE
then rm -f "$STATUS_JSON"; REASON="Production update state does not match the qualified package/stable predecessor"; finish; fi
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

if ! disk_headroom_ok; then
  REASON="Insufficient free disk space for OpenClaw mutation after backup; at least 2 GiB is required"
  finish
fi

UPDATE_JSON=$(mktemp "$EXEC_DIR/update-$REQUEST_ID.XXXXXX")
chmod 600 "$UPDATE_JSON"
MUTATION_STARTED=true
set +e
"$OPENCLAW_BIN" update --tag "$TARGET_OPENCLAW_VERSION" --json >"$UPDATE_JSON" 2>>"$LOG"
UPDATE_EXIT=$?
set -e
UPDATE_UNSAFE=false
if node - "$UPDATE_JSON" <<'NODE'
const fs=require('fs');let v;try{v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));}catch{process.exit(2);}process.exit(v?.recovery?.serviceRestartSafe===false?0:1);
NODE
then UPDATE_UNSAFE=true; fi
if [ "$UPDATE_EXIT" -ne 0 ]; then
  rm -f "$UPDATE_JSON"
  CORE_VERSION=$(read_openclaw_version 2>/dev/null || true)
  if gateway_health; then GATEWAY_READY=true; else GATEWAY_READY=false; fi
  STAGE="OPENCLAW_UPDATE"
  if [ "$UPDATE_UNSAFE" = true ] || [ "$CORE_VERSION" != "$EXPECTED_OPENCLAW_VERSION" ] || [ "$GATEWAY_READY" != true ]; then
    OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; REASON="OpenClaw update failed without a proven safe predecessor runtime"
  else
    OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; BLOCK_FURTHER=true; REASON="OpenClaw update failed after mutation; predecessor runtime appears healthy but reconciliation is required before further production changes"
  fi
  finish
fi
if ! TARGET_ENV="$TARGET_OPENCLAW_VERSION" node - "$UPDATE_JSON" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(v?.status!=='ok'||(v?.after?.version&&v.after.version!==process.env.TARGET_ENV)||v?.recovery?.serviceRestartSafe===false||v?.postUpdate?.plugins?.status==='error')process.exit(2);
NODE
then rm -f "$UPDATE_JSON"; OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; BLOCK_FURTHER=true; STAGE="OPENCLAW_UPDATE"; REASON="OpenClaw updater returned an unaccepted post-update result"; finish; fi
rm -f "$UPDATE_JSON"

CORE_VERSION=$(read_openclaw_version 2>/dev/null || true)
if [ "$CORE_VERSION" != "$TARGET_OPENCLAW_VERSION" ]; then OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="OPENCLAW_ACCEPTANCE"; REASON="Installed OpenClaw version does not match the frozen target"; finish; fi
if gateway_health; then GATEWAY_READY=true; else GATEWAY_READY=false; fi
if [ "$GATEWAY_READY" != true ]; then OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="OPENCLAW_ACCEPTANCE"; REASON="Gateway health RPC did not recover after the OpenClaw update"; finish; fi

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

TASK_LOG_START=$(wc -l < "$LOG" 2>/dev/null || echo 0)
set +e
PATH="$DEPLOY_PATH" "$DEPLOY" --apply >>"$LOG" 2>&1
TASK_EXIT=$?
set -e
TASK_RESULT_FILE=$(tail -n "+$((TASK_LOG_START+1))" "$LOG" | awk -F= '/^RESULT_FILE=/{v=$2} END{print v}')
if [ -z "$TASK_RESULT_FILE" ] || [ ! -f "$TASK_RESULT_FILE" ]; then OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="TASK_DEPLOY"; REASON="Task deploy did not publish durable result evidence"; finish; fi
TASK_FIELDS=$(node - "$TASK_RESULT_FILE" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));process.stdout.write(`${v?.result??''}\t${v?.stage??''}\t${v?.mutation_started===true?'true':'false'}`);
NODE
) || { OUTCOME="RECOVERY_REQUIRED"; BLOCK_FURTHER=true; STAGE="TASK_DEPLOY"; REASON="Task deploy result evidence is unreadable"; finish; }
IFS=$'\t' read -r TASK_DEPLOY_RESULT TASK_DEPLOY_STAGE TASK_MUTATION_STARTED <<<"$TASK_FIELDS"
if [ "$TASK_EXIT" -ne 0 ] || [ "$TASK_DEPLOY_RESULT" != "PASS" ]; then
  STAGE="TASK_DEPLOY"; BLOCK_FURTHER=true
  if [ "$TASK_DEPLOY_RESULT" = "BLOCKED" ] && [ "$TASK_MUTATION_STARTED" = true ]; then OUTCOME="RECOVERY_REQUIRED"; REASON="Task deploy failed without a proven Task rollback"; else OUTCOME="BLOCKED_REQUIRES_JUDGMENT"; REASON="Task deploy did not complete the frozen rollout target"; fi
  finish
fi

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

OUTCOME="SUCCESS"
BLOCK_FURTHER=false
STAGE="COMPLETE"
REASON=""
finish
