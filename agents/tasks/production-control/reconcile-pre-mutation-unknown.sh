#!/usr/bin/env bash
set -euo pipefail
umask 077

TEST_MODE="${OPC_TEST_MODE:-0}"
STATE_DIR="${OPC_STATE_DIR:-$HOME/.local/state/openclaw-production-control}"
LIB_DIR="${OPC_LIB_DIR:-$HOME/.local/lib/openclaw-production-control}"
STATE_FILE="$STATE_DIR/state.json"
DIAGNOSE="${OPC_DIAGNOSE:-$LIB_DIR/diagnose.mjs}"
REVISION_FILE="${OPC_INSTALLED_REVISION_FILE:-$LIB_DIR/installed-revision}"
SYSTEMCTL="${OPC_SYSTEMCTL:-systemctl}"
REQUEST_ID=""
EXPECTED_TARGET_SHA=""
EXPECTED_PRODUCTION_SHA=""
EXPECTED_CONTROLLER_SHA=""
EXPECTED_PROTECTED_SHA=""
EXPECTED_OPENCLAW_VERSION=""
EXPECTED_TARGET_OPENCLAW_VERSION=""
APPLY=false

fail(){ echo "PRE_MUTATION_RECONCILIATION_REFUSED: $*" >&2; exit 2; }
required_value(){ [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || fail "$1 requires a value"; }

if [ "$TEST_MODE" = 1 ]; then
  case "$STATE_DIR" in /tmp/*) ;; *) fail "test mode state must be under /tmp" ;; esac
else
  [ "$TEST_MODE" = 0 ] || fail "invalid OPC_TEST_MODE"
  for name in OPC_STATE_DIR OPC_LIB_DIR OPC_DIAGNOSE OPC_INSTALLED_REVISION_FILE OPC_SYSTEMCTL; do
    [ -z "${!name:-}" ] || fail "$name is test-only"
  done
  STATE_DIR="$HOME/.local/state/openclaw-production-control"
  LIB_DIR="$HOME/.local/lib/openclaw-production-control"
  STATE_FILE="$STATE_DIR/state.json"
  DIAGNOSE="$LIB_DIR/diagnose.mjs"
  REVISION_FILE="$LIB_DIR/installed-revision"
  SYSTEMCTL=systemctl
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --request-id) required_value "$@"; REQUEST_ID=$2; shift 2 ;;
    --expected-target-sha) required_value "$@"; EXPECTED_TARGET_SHA=$2; shift 2 ;;
    --expected-production-sha) required_value "$@"; EXPECTED_PRODUCTION_SHA=$2; shift 2 ;;
    --expected-controller-sha) required_value "$@"; EXPECTED_CONTROLLER_SHA=$2; shift 2 ;;
    --expected-protected-sha) required_value "$@"; EXPECTED_PROTECTED_SHA=$2; shift 2 ;;
    --expected-openclaw-version) required_value "$@"; EXPECTED_OPENCLAW_VERSION=$2; shift 2 ;;
    --expected-target-openclaw-version) required_value "$@"; EXPECTED_TARGET_OPENCLAW_VERSION=$2; shift 2 ;;
    --apply) APPLY=true; shift ;;
    *) fail "unknown argument $1" ;;
  esac
done

[[ "$REQUEST_ID" =~ ^[1-9][0-9]*$ ]] || fail "invalid request id"
for value in "$EXPECTED_TARGET_SHA" "$EXPECTED_PRODUCTION_SHA" "$EXPECTED_CONTROLLER_SHA" "$EXPECTED_PROTECTED_SHA"; do
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || fail "invalid SHA input"
done
[[ "$EXPECTED_OPENCLAW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid predecessor OpenClaw version"
[[ "$EXPECTED_TARGET_OPENCLAW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid target OpenClaw version"
[ -f "$STATE_FILE" ] || fail "controller state missing"
[ -f "$REVISION_FILE" ] || fail "installed controller revision evidence missing"
[ -f "$DIAGNOSE" ] || fail "diagnostic entrypoint missing"
mkdir -p "$STATE_DIR/recovery"
chmod 700 "$STATE_DIR" "$STATE_DIR/recovery"
exec 9>"$STATE_DIR/poll.lock"
flock -n 9 || fail "production-control lock is busy"

is_active(){ "$SYSTEMCTL" --user is-active "$1" >/dev/null 2>&1; }
! is_active openclaw-task-production-control.timer || fail "routine controller timer must be inactive"
! is_active openclaw-task-production-control.service || fail "routine controller service must be inactive"
is_active openclaw-gateway.service || fail "OpenClaw Gateway must be active"
is_active nexus-sync.timer || fail "Nexus sync timer must be active"

STATE_UID=$(stat -c '%u' "$STATE_FILE")
STATE_MODE=$(stat -c '%a' "$STATE_FILE")
[ "$STATE_UID" = "$(id -u)" ] || fail "controller state owner mismatch"
[ "$STATE_MODE" = 600 ] || fail "controller state mode must be 600"
INSTALLED_REVISION=$(tr -d '\r\n' < "$REVISION_FILE")
[ "$INSTALLED_REVISION" = "$EXPECTED_CONTROLLER_SHA" ] || fail "installed controller revision mismatch"
EVIDENCE_FILE="$STATE_DIR/executions/request-$REQUEST_ID.json"
[ -f "$EVIDENCE_FILE" ] || fail "operation evidence missing"
[ "$(stat -c '%u' "$EVIDENCE_FILE")" = "$(id -u)" ] || fail "operation evidence owner mismatch"
[ "$(stat -c '%a' "$EVIDENCE_FILE")" = 600 ] || fail "operation evidence mode must be 600"

PREFLIGHT_JSON=$(mktemp "$STATE_DIR/pre-mutation-preflight-$REQUEST_ID.XXXXXX")
DIAG_BEFORE=$(mktemp "$STATE_DIR/pre-mutation-diagnose-before-$REQUEST_ID.XXXXXX")
DIAG_AFTER=$(mktemp "$STATE_DIR/pre-mutation-diagnose-after-$REQUEST_ID.XXXXXX")
chmod 600 "$PREFLIGHT_JSON" "$DIAG_BEFORE" "$DIAG_AFTER"
cleanup_tmp(){ rm -f "$PREFLIGHT_JSON" "$DIAG_BEFORE" "$DIAG_AFTER"; }
trap cleanup_tmp EXIT

node - "$STATE_FILE" "$EVIDENCE_FILE" "$REQUEST_ID" "$EXPECTED_TARGET_SHA" "$EXPECTED_PRODUCTION_SHA" "$EXPECTED_CONTROLLER_SHA" "$EXPECTED_PROTECTED_SHA" "$EXPECTED_OPENCLAW_VERSION" "$EXPECTED_TARGET_OPENCLAW_VERSION" >"$PREFLIGHT_JSON" <<'NODE'
const fs=require('fs');
const [stateFile,evidenceFile,idRaw,target,baseline,controller,protectedSha,predecessorVersion,targetVersion]=process.argv.slice(2);
const id=Number(idRaw),s=JSON.parse(fs.readFileSync(stateFile,'utf8')),e=JSON.parse(fs.readFileSync(evidenceFile,'utf8'));
const fail=()=>process.exit(2), r=s?.requests?.[String(id)];
const active=Object.values(s?.requests??{}).filter(v=>v?.state==='STARTING'||v?.state==='IN_PROGRESS');
if(s?.version!==1||s?.mode!=='ACTIVE'||s?.deployment_blocked!==true||s?.block_reason!==`request ${id} ended UNKNOWN`)fail();
if(s?.controller_revision!==controller||s?.production_baseline_sha!==baseline||(Object.hasOwn(s,'protected_path_baseline_sha')?s.protected_path_baseline_sha:s.controller_revision)!==protectedSha)fail();
if(active.length!==0||!r||r.type!=='rollout-openclaw'||r.source!=='github'||r.sha!==target||r.state!=='UNKNOWN')fail();
if(r.evidence_error!=='recovery-required evidence is inconsistent')fail();
if(Number(e?.request_id)!==id||e?.source_revision!==target||e?.outcome!=='RECOVERY_REQUIRED'||e?.stage!=='TASK_PREDEPLOY')fail();
if(e?.mutation_started!==false||e?.block_further_deployments!==true||e?.predecessor_openclaw_version!==predecessorVersion||e?.target_openclaw_version!==targetVersion||e?.core_version!==predecessorVersion)fail();
if(e?.task_predeploy_result!==null||e?.task_deploy_result!==null||e?.task_predeploy_mutation_started!==false||e?.task_mutation_started!==false)fail();
if(e?.backup_created!==true||typeof e?.backup_archive!=='string'||!/^[0-9a-f]{64}$/u.test(e?.backup_sha256??''))fail();
process.stdout.write(JSON.stringify({backup_archive:e.backup_archive,backup_sha256:e.backup_sha256}));
NODE
[ "$?" -eq 0 ] || fail "controller/request/evidence preconditions failed"
BACKUP_ARCHIVE=$(node -e 'const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(v.backup_archive)' "$PREFLIGHT_JSON")
BACKUP_SHA=$(node -e 'const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(v.backup_sha256)' "$PREFLIGHT_JSON")
[ -f "$BACKUP_ARCHIVE" ] || fail "verified rollout backup archive missing"
[ "$(stat -c '%u' "$BACKUP_ARCHIVE")" = "$(id -u)" ] || fail "rollout backup owner mismatch"
[ "$(stat -c '%a' "$BACKUP_ARCHIVE")" = 600 ] || fail "rollout backup mode must be 600"
[ "$(sha256sum "$BACKUP_ARCHIVE" | awk '{print $1}')" = "$BACKUP_SHA" ] || fail "rollout backup checksum mismatch"

node "$DIAGNOSE" >"$DIAG_BEFORE" || fail "current production diagnostics failed"
node - "$DIAG_BEFORE" "$EXPECTED_PRODUCTION_SHA" "$EXPECTED_OPENCLAW_VERSION" <<'NODE' || exit 2
const fs=require('fs'),d=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),baseline=process.argv[3],version=process.argv[4];
const p=d?.checks?.provenance,r=d?.checks?.runtime,rel=d?.checks?.release;
if(d?.ok!==true||p?.production_baseline_sha!==baseline||p?.source_revision!==baseline||r?.openclaw_version!==version||r?.expected_openclaw_version!==version||rel?.ok!==true)process.exit(2);
NODE
[ "$?" -eq 0 ] || fail "diagnostics do not prove unchanged predecessor baseline"

if [ "$APPLY" != true ]; then
  echo "PRE_MUTATION_RECONCILIATION_PREFLIGHT_PASS request=$REQUEST_ID baseline=$EXPECTED_PRODUCTION_SHA"
  exit 0
fi

STAMP=$(date -u +%Y-%m-%dT%H-%M-%S.%NZ)
RECOVERY_DIR="$STATE_DIR/recovery/pre-mutation-request-$REQUEST_ID/$STAMP"
mkdir -p "$RECOVERY_DIR"
chmod 700 "$STATE_DIR/recovery/pre-mutation-request-$REQUEST_ID" "$RECOVERY_DIR"
cp -p "$STATE_FILE" "$RECOVERY_DIR/state.before.json"
cp -p "$EVIDENCE_FILE" "$RECOVERY_DIR/operation-evidence.json"
cp -p "$DIAG_BEFORE" "$RECOVERY_DIR/diagnose.before.json"
STATE_MUTATED=false
restore_state(){
  [ "$STATE_MUTATED" = true ] || return 0
  local restore_tmp
  restore_tmp=$(mktemp "$STATE_DIR/state.json.restore.$REQUEST_ID.XXXXXX") || return 1
  if ! install -m 600 "$RECOVERY_DIR/state.before.json" "$restore_tmp"; then
    rm -f "$restore_tmp"
    return 1
  fi
  if ! mv "$restore_tmp" "$STATE_FILE"; then
    rm -f "$restore_tmp"
    return 1
  fi
  STATE_MUTATED=false
}
restore_on_error(){
  rc=$?
  trap - ERR INT TERM
  if [ "$rc" -ne 0 ] && ! restore_state; then
    echo "PRE_MUTATION_RECONCILIATION_RECOVERY_INCOMPLETE" >&2
    exit 3
  fi
  exit "$rc"
}
restore_on_signal(){
  rc=$1
  trap - ERR INT TERM
  if ! restore_state; then
    echo "PRE_MUTATION_RECONCILIATION_RECOVERY_INCOMPLETE" >&2
    exit 3
  fi
  exit "$rc"
}
trap 'restore_on_error' ERR
trap 'restore_on_signal 130' INT
trap 'restore_on_signal 143' TERM
CANDIDATE="$STATE_DIR/state.json.pre-mutation.$REQUEST_ID.$$"
node - "$STATE_FILE" "$DIAG_BEFORE" "$CANDIDATE" "$REQUEST_ID" "$EXPECTED_PRODUCTION_SHA" <<'NODE'
const fs=require('fs');
const [stateFile,diagFile,out,idRaw,baseline]=process.argv.slice(2),id=Number(idRaw),s=JSON.parse(fs.readFileSync(stateFile,'utf8')),d=JSON.parse(fs.readFileSync(diagFile,'utf8')),now=new Date().toISOString(),r=s.requests[String(id)];
r.reconciled_from_state=r.state;
r.state='BLOCKED_PRE_MUTATION';
r.reconciliation={kind:'proven-pre-mutation-v1',reconciled_at:now,production_baseline_sha:baseline,reason:'independent diagnostics proved the predecessor runtime unchanged after a pre-mutation rollout failure'};
s.deployment_blocked=false;s.block_reason=null;s.last_diagnostic={...d,checked_at:now,sha:baseline,request_id:id};
fs.writeFileSync(out,JSON.stringify(s,null,2)+'\n',{mode:0o600});
NODE
chmod 600 "$CANDIDATE"
STATE_MUTATED=true
mv "$CANDIDATE" "$STATE_FILE"
node "$DIAGNOSE" >"$DIAG_AFTER" || false
if ! node - "$DIAG_AFTER" "$EXPECTED_PRODUCTION_SHA" "$EXPECTED_OPENCLAW_VERSION" <<'NODE'
const fs=require('fs'),d=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),baseline=process.argv[3],version=process.argv[4];
if(d?.ok!==true||d?.checks?.provenance?.production_baseline_sha!==baseline||d?.checks?.provenance?.source_revision!==baseline||d?.checks?.runtime?.openclaw_version!==version||d?.checks?.release?.ok!==true)process.exit(2);
NODE
then
  restore_state || { echo "PRE_MUTATION_RECONCILIATION_RECOVERY_INCOMPLETE" >&2; exit 3; }
  fail "post-reconciliation diagnostics failed; state restored"
fi
cp -p "$DIAG_AFTER" "$RECOVERY_DIR/diagnose.after.json"
RESULT_FILE="$RECOVERY_DIR/reconciliation-result.json"
node - "$STATE_FILE" "$RESULT_FILE" "$REQUEST_ID" "$EXPECTED_PRODUCTION_SHA" <<'NODE'
const fs=require('fs'),s=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),out=process.argv[3],id=Number(process.argv[4]),baseline=process.argv[5],r=s.requests[String(id)];
if(s.deployment_blocked!==false||s.block_reason!==null||s.production_baseline_sha!==baseline||r?.state!=='BLOCKED_PRE_MUTATION'||r?.reconciliation?.kind!=='proven-pre-mutation-v1')process.exit(2);
fs.writeFileSync(out,JSON.stringify({ok:true,request_id:id,reconciled_state:r.state,production_baseline_sha:baseline,controller_revision:s.controller_revision,protected_path_baseline_sha:s.protected_path_baseline_sha,reconciled_at:r.reconciliation.reconciled_at},null,2)+'\n',{mode:0o600});
NODE
chmod 600 "$RESULT_FILE"
STATE_MUTATED=false
trap - ERR INT TERM
echo "PRE_MUTATION_RECONCILIATION_PASS request=$REQUEST_ID baseline=$EXPECTED_PRODUCTION_SHA"
echo "RESULT_FILE=$RESULT_FILE"
