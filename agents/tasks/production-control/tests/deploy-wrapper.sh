#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/source/agents/tasks" "$TMP/state" "$TMP/deliverables" "$TMP/home/.npm-global/bin"

cat > "$TMP/home/.npm-global/bin/openclaw" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 700 "$TMP/home/.npm-global/bin/openclaw"
export HOME="$TMP/home"
case ":$PATH:" in
  *":$HOME/.npm-global/bin:"*) echo "Test precondition failed: npm-global bin already present in PATH" >&2; exit 1 ;;
esac

make_deploy(){
  local result=$1 mutation=$2 exit_code=$3 stage=$4 print_result=${5:-yes}
  local execution="fake-execution-$result-$stage"
  local result_file="$TMP/deploy-result.json"
  if [ "$print_result" = no ]; then result_file="$TMP/deliverables/$execution-result.json"; fi
  cat > "$TMP/source/agents/tasks/deploy.sh" <<EOF
#!/usr/bin/env bash
set -u
command -v openclaw >/dev/null 2>&1 || exit 97
R="$result_file"
echo 'EXECUTION_ID=$execution'
cat > "\$R" <<JSON
{"execution_id":"$execution","result":"$result","stage":"$stage","message":"synthetic","source_revision":"0123456789abcdef0123456789abcdef01234567","rollback_count":$([ "$result" = ROLLED_BACK ] && echo 1 || echo 0),"mutation_started":$mutation,"gateway_stopped":false}
JSON
$([ "$print_result" = yes ] && printf '%s\n' 'echo "RESULT_FILE=$R"' || printf '%s\n' ':')
exit $exit_code
EOF
  chmod 700 "$TMP/source/agents/tasks/deploy.sh"
}

assert_outcome(){
  local request=$1 expected=$2
  node - "$TMP/state/executions/request-$request.json" "$expected" <<'NODE'
const fs=require('fs');
const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(r.outcome!==process.argv[3]){console.error(r);process.exit(1)}
NODE
}

make_deploy PASS false 0 NOOP
bash "$ROOT/execute-deploy.sh" 1 "$TMP/source" "$TMP/state"
assert_outcome 1 SUCCESS

make_deploy BLOCKED false 2 SOURCE
if bash "$ROOT/execute-deploy.sh" 2 "$TMP/source" "$TMP/state"; then exit 1; fi
assert_outcome 2 BLOCKED_PRE_MUTATION

make_deploy ROLLED_BACK true 1 OFFLINE_VALIDATE
if bash "$ROOT/execute-deploy.sh" 3 "$TMP/source" "$TMP/state"; then exit 1; fi
assert_outcome 3 ROLLED_BACK

make_deploy BLOCKED true 2 ROLLBACK
if bash "$ROOT/execute-deploy.sh" 4 "$TMP/source" "$TMP/state"; then exit 1; fi
assert_outcome 4 RECOVERY_REQUIRED

# Real deploy.sh failure paths write durable evidence but do not print RESULT_FILE.
# The wrapper must recover the result path from EXECUTION_ID rather than misclassify
# a proven rollback as UNKNOWN.
make_deploy ROLLED_BACK true 1 POST_RESTART no
if OPC_TASK_DELIVERABLES="$TMP/deliverables" bash "$ROOT/execute-deploy.sh" 5 "$TMP/source" "$TMP/state"; then exit 1; fi
assert_outcome 5 ROLLED_BACK

# The production deploy entrypoint itself must resolve OpenClaw from the
# owner-local npm prefix when invoked with a detached/noninteractive PATH.
SANITIZED_PATH="$(dirname "$(command -v node)"):/usr/bin:/bin"
case ":$SANITIZED_PATH:" in
  *":$HOME/.npm-global/bin:"*) echo "Sanitized PATH unexpectedly includes npm-global bin" >&2; exit 1 ;;
esac
PATH_PROBE_LOG="$TMP/deploy-path-probe.log"
set +e
PATH="$SANITIZED_PATH" HOME="$HOME" bash "$ROOT/../deploy.sh" --test-root "$TMP/path-probe" --preflight >"$PATH_PROBE_LOG" 2>&1
PATH_PROBE_CODE=$?
set -e
[ "$PATH_PROBE_CODE" -eq 2 ] || { cat "$PATH_PROBE_LOG" >&2; echo "Detached PATH probe returned unexpected code $PATH_PROBE_CODE" >&2; exit 1; }
grep -q 'unsupported OpenClaw generation:' "$PATH_PROBE_LOG" || { cat "$PATH_PROBE_LOG" >&2; echo "Detached PATH probe did not reach OpenClaw version validation" >&2; exit 1; }
if grep -q 'Required command unavailable: openclaw' "$PATH_PROBE_LOG"; then
  cat "$PATH_PROBE_LOG" >&2
  echo "Detached PATH probe could not resolve owner-local OpenClaw" >&2
  exit 1
fi

echo DEPLOY_WRAPPER_TEST_PASS
