#!/usr/bin/env bash
set -uo pipefail
umask 077

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <request-id> <source-checkout> <controller-state-dir>" >&2
  exit 2
fi

REQUEST_ID=$1
SOURCE_DIR=$2
STATE_DIR=$3

[[ "$REQUEST_ID" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid request id" >&2; exit 2; }
case "$SOURCE_DIR" in /*) ;; *) echo "Source checkout must be absolute" >&2; exit 2;; esac
case "$STATE_DIR" in /*) ;; *) echo "State directory must be absolute" >&2; exit 2;; esac

DEPLOY="$SOURCE_DIR/agents/tasks/deploy.sh"
[ -x "$DEPLOY" ] || { echo "Frozen deploy entrypoint is unavailable or not executable" >&2; exit 2; }
DEPLOY_PATH="$HOME/.npm-global/bin${PATH:+:$PATH}"

EXEC_DIR="$STATE_DIR/executions"
mkdir -p "$EXEC_DIR"
chmod 700 "$EXEC_DIR"
LOG="$EXEC_DIR/request-$REQUEST_ID.log"
RESULT="$EXEC_DIR/request-$REQUEST_ID.json"
TMP="$RESULT.tmp.$$"
: > "$LOG"
chmod 600 "$LOG"

set +e
PATH="$DEPLOY_PATH" "$DEPLOY" --apply > >(tee -a "$LOG") 2>&1
DEPLOY_EXIT=$?
set -e

DEPLOY_RESULT_FILE=$(awk -F= '/^RESULT_FILE=/{v=$2} END{print v}' "$LOG")
DEPLOY_EXECUTION_ID=$(awk -F= '/^EXECUTION_ID=/{v=$2} END{print v}' "$LOG")
if [ -z "$DEPLOY_RESULT_FILE" ] && [ -n "$DEPLOY_EXECUTION_ID" ]; then
  DEPLOY_DELIVERABLES=${OPC_TASK_DELIVERABLES:-"$HOME/.openclaw/workspace/deliverables"}
  CANDIDATE="$DEPLOY_DELIVERABLES/${DEPLOY_EXECUTION_ID}-result.json"
  if [ -f "$CANDIDATE" ]; then DEPLOY_RESULT_FILE=$CANDIDATE; fi
fi

REQUEST_ID_ENV="$REQUEST_ID" DEPLOY_EXIT_ENV="$DEPLOY_EXIT" \
DEPLOY_RESULT_FILE_ENV="$DEPLOY_RESULT_FILE" DEPLOY_EXECUTION_ID_ENV="$DEPLOY_EXECUTION_ID" \
LOCAL_LOG_ENV="$LOG" node - "$TMP" <<'NODE'
const fs = require('fs');
const requestId = Number(process.env.REQUEST_ID_ENV);
const exitCode = Number(process.env.DEPLOY_EXIT_ENV);
const evidencePath = process.env.DEPLOY_RESULT_FILE_ENV || '';
let evidence = null;
if (evidencePath) {
  try { evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')); } catch {}
}
let outcome = 'UNKNOWN';
let block = true;
if (evidence?.result === 'PASS' && exitCode === 0) { outcome = 'SUCCESS'; block = false; }
else if (evidence?.result === 'ROLLED_BACK') { outcome = 'ROLLED_BACK'; block = false; }
else if (evidence?.result === 'BLOCKED' && evidence?.mutation_started === false) { outcome = 'BLOCKED_PRE_MUTATION'; block = false; }
else if (evidence?.result === 'BLOCKED' && evidence?.mutation_started === true) { outcome = 'RECOVERY_REQUIRED'; block = true; }
const result = {
  request_id: requestId,
  outcome,
  block_further_deployments: block,
  wrapper_exit_code: exitCode,
  deploy_execution_id: evidence?.execution_id || process.env.DEPLOY_EXECUTION_ID_ENV || null,
  source_revision: evidence?.source_revision || null,
  deploy_result: evidence?.result || null,
  deploy_stage: evidence?.stage || null,
  deploy_message: evidence?.message || null,
  rollback_count: Number(evidence?.rollback_count || 0),
  mutation_started: evidence?.mutation_started === true,
  gateway_stopped: evidence?.gateway_stopped === true,
  local_log: process.env.LOCAL_LOG_ENV,
  deploy_result_file: evidencePath || null,
  completed_at: new Date().toISOString(),
};
fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
NODE
mv -f "$TMP" "$RESULT"
chmod 600 "$RESULT"

if [ "$DEPLOY_EXIT" -eq 0 ]; then
  exit 0
fi
exit "$DEPLOY_EXIT"
