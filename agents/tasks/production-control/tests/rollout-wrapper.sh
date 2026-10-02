#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
WRAPPER="$ROOT/agents/tasks/production-control/execute-rollout.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SRC="$TMP/source"
STATE="$TMP/controller-state"
FAKEBIN="$TMP/bin"
FAKE_STATE="$TMP/openclaw-version"
FAKE_TRACE="$TMP/trace"
FAKE_DF_BACKUP_MARKER="$TMP/backup-created"
TASK_RESULT_DIR="$TMP/task-results"
FAKE_HOME="$TMP/home"
mkdir -p "$FAKE_HOME" "$SRC/agents/tasks/production-control" "$SRC/shared/runtime-contract" "$STATE" "$FAKEBIN" "$TASK_RESULT_DIR"

cat > "$SRC/runtime-contract.json" <<'JSON'
{
  "format": "openclaw-agents-runtime-contract-v2",
  "node": {
    "ci_version": "26.7.0",
    "supported_lines": [{ "major": 26, "minimum": "26.0.0" }],
    "required_builtin_modules": ["node:sqlite"]
  }
}
JSON
cat > "$SRC/openclaw-qualification.json" <<'JSON'
{
  "format": "openclaw-qualification-target-v1",
  "version": "2026.8.2"
}
JSON
cp "$ROOT/shared/runtime-contract/runtime-contract.mjs" "$SRC/shared/runtime-contract/runtime-contract.mjs"
cp "$ROOT/agents/tasks/production-control/specialized-agent-acceptance.mjs" "$SRC/agents/tasks/production-control/specialized-agent-acceptance.mjs"
cat > "$SRC/agents/tasks/deploy.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$FAKE_TASK_RESULT_DIR"
count=$(cat "$FAKE_TASK_CALL_COUNTER" 2>/dev/null || echo 0)
count=$((count+1))
printf '%s\n' "$count" > "$FAKE_TASK_CALL_COUNTER"
RESULT="$FAKE_TASK_RESULT_DIR/result-${count}-${RANDOM}.json"
if [ "$count" -eq 1 ] && [ "${FAKE_PREDEPLOY_NO_RESULT:-0}" = 1 ]; then
  exit 2
fi
if [ "$count" -eq 1 ]; then
  OUTCOME=${FAKE_PREDEPLOY_OUTCOME:-PASS}
  STAGE=${FAKE_PREDEPLOY_STAGE:-COMPLETE}
  MUTATION=${FAKE_PREDEPLOY_MUTATION:-true}
else
  OUTCOME=${FAKE_TASK_OUTCOME:-PASS}
  STAGE=${FAKE_TASK_STAGE:-NOOP}
  MUTATION=${FAKE_TASK_MUTATION:-false}
fi
printf '{"result":"%s","stage":"%s","mutation_started":%s}\n' "$OUTCOME" "$STAGE" "$MUTATION" > "$RESULT"
echo "RESULT_FILE=$RESULT"
[ "$OUTCOME" = PASS ] && exit 0
exit 2
SH
chmod 700 "$SRC/agents/tasks/deploy.sh"

git -C "$SRC" init -q
git -C "$SRC" config user.email test@example.invalid
git -C "$SRC" config user.name test
git -C "$SRC" add .
git -C "$SRC" commit -qm fixture

cat > "$FAKEBIN/openclaw" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_TRACE"
case "${1:-}" in
  --version)
    echo "OpenClaw $(cat "$FAKE_STATE")"
    ;;
  config)
    case "${2:-}" in
      validate)
        if [ "${FAKE_CONFIG_INVALID:-0}" = 1 ]; then
          echo '{"valid":false,"issues":[{"path":"agents.entries","message":"fake invalid config"}]}'
        else
          echo '{"valid":true,"issues":[]}'
        fi
        ;;
      get)
        [ "${3:-}" = agents.entries ] || exit 2
        if [ "${FAKE_AGENT_TOOL_DRIFT_AFTER_UPDATE:-0}" = 1 ] && [ "$(cat "$FAKE_STATE")" = 2026.8.2 ]; then
          echo '{"main":{"tools":{"alsoAllow":["contacts"]}},"tasks":{"tools":{"profile":"full","allow":["task_list"],"deny":[],"fs":{"workspaceOnly":true}}},"engineer":{"tools":{"allow":["read","exec","process"],"deny":["write"],"fs":{"workspaceOnly":true}}},"calendar":{"tools":{"allow":["calendar_analyze"],"deny":["exec"]}},"investments":{"tools":{"allow":["read","investment_holdings"],"deny":["write","exec"]}}}'
        else
          echo '{"main":{"tools":{"alsoAllow":["contacts"]}},"tasks":{"tools":{"profile":"full","allow":["task_list"],"deny":["exec"],"fs":{"workspaceOnly":true}}},"engineer":{"tools":{"allow":["read","exec","process"],"deny":["write"],"fs":{"workspaceOnly":true}}},"calendar":{"tools":{"allow":["calendar_analyze"],"deny":["exec"]}},"investments":{"tools":{"allow":["read","investment_holdings"],"deny":["write","exec"]}}}'
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  agents)
    [ "${2:-}" = list ] || exit 2
    if [ "${FAKE_AGENT_DRIFT_AFTER_UPDATE:-0}" = 1 ] && [ "$(cat "$FAKE_STATE")" = 2026.8.2 ]; then
      echo '[{"id":"main"},{"id":"tasks"},{"id":"engineer"},{"id":"calendar"}]'
    else
      echo '[{"id":"main"},{"id":"tasks"},{"id":"engineer"},{"id":"calendar"},{"id":"investments"}]'
    fi
    ;;
  gateway)
    if [ "${2:-}" = health ]; then
      [ "${FAKE_HEALTH_FAIL:-0}" != 1 ] || exit 1
      echo '{"ok":true}'
    else
      exit 2
    fi
    ;;
  update)
    if [ "${2:-}" = status ]; then
      count=$(cat "$FAKE_STATUS_CALL_COUNTER" 2>/dev/null || echo 0)
      count=$((count+1))
      printf '%s\n' "$count" > "$FAKE_STATUS_CALL_COUNTER"
      if [ "${FAKE_BAD_STATUS:-0}" = 1 ]; then channel=beta; else channel=stable; fi
      if [ "$count" -eq 1 ] && [ "${FAKE_ACTIVE_RUN:-0}" = 1 ]; then
        printf '{"channel":{"value":"%s"},"update":{"installKind":"package"},"activeRun":{"runId":"run-active","createdAtMs":9999999999999,"phase":"validating","status":"running","target":{"version":"2026.8.2"},"before":{"version":"2026.8.1"}},"lastRun":null}\n' "$channel"
      elif [ "$count" -eq 1 ]; then
        printf '{"channel":{"value":"%s"},"update":{"installKind":"package"},"activeRun":null,"lastRun":{"runId":"run-old","createdAtMs":1,"phase":"finished","status":"succeeded","target":{"version":"2026.8.1"},"before":{"version":"2026.8.0"},"after":{"version":"2026.8.1"}}}\n' "$channel"
      elif [ "${FAKE_UPDATE_HANDOFF_SUCCESS:-0}" = 1 ]; then
        if [ "$count" -eq 2 ]; then
          echo '{"channel":{"value":"stable"},"update":{"installKind":"package"},"activeRun":{"runId":"run-handoff","createdAtMs":9999999999999,"phase":"activating","status":"running","target":{"version":"2026.8.2"},"before":{"version":"2026.8.1"}},"lastRun":null}'
        else
          echo 2026.8.2 > "$FAKE_STATE"
          echo '{"channel":{"value":"stable"},"update":{"installKind":"package"},"activeRun":null,"lastRun":{"runId":"run-handoff","createdAtMs":9999999999999,"phase":"finished","status":"succeeded","target":{"version":"2026.8.2"},"before":{"version":"2026.8.1"},"after":{"version":"2026.8.2"},"verification":{"recovery":{"serviceRestartSafe":true}}}}'
        fi
      elif [ "${FAKE_UPDATE_HANDOFF_UNSAFE:-0}" = 1 ]; then
        echo '{"channel":{"value":"stable"},"update":{"installKind":"package"},"activeRun":null,"lastRun":{"runId":"run-handoff-unsafe","createdAtMs":9999999999999,"phase":"finished","status":"succeeded","target":{"version":"2026.8.2"},"before":{"version":"2026.8.1"},"after":{"version":"2026.8.2"},"verification":{"recovery":{"serviceRestartSafe":false}}}}'
      elif [ "${FAKE_UPDATE_HANDOFF_UNSAFE_NO_AFTER:-0}" = 1 ]; then
        echo '{"channel":{"value":"stable"},"update":{"installKind":"package"},"activeRun":null,"lastRun":{"runId":"run-handoff-unsafe-no-after","createdAtMs":9999999999999,"phase":"finished","status":"failed","target":{"version":"2026.8.2"},"before":{"version":"2026.8.1"},"recovery":{"serviceRestartSafe":false}}}'
      elif [ "${FAKE_UPDATE_NO_RUN_ID:-0}" = 1 ]; then
        echo 2026.8.2 > "$FAKE_STATE"
        echo '{"channel":{"value":"stable"},"update":{"installKind":"package"},"activeRun":null,"lastRun":{"runId":"run-unrelated","createdAtMs":9999999999999,"phase":"finished","status":"succeeded","target":{"version":"2026.8.2"},"before":{"version":"2026.8.1"},"after":{"version":"2026.8.2"},"verification":{"recovery":{"serviceRestartSafe":true}}}}'
      elif [ "${FAKE_UPDATE_FAIL:-0}" = 1 ]; then
        echo '{"channel":{"value":"stable"},"update":{"installKind":"package"},"activeRun":null,"lastRun":{"runId":"run-failed","createdAtMs":9999999999999,"phase":"finished","status":"failed","reason":"fake-failure","target":{"version":"2026.8.2"},"before":{"version":"2026.8.1"},"recovery":{"serviceRestartSafe":true}}}'
      else
        echo '{"channel":{"value":"stable"},"update":{"installKind":"package"},"activeRun":null,"lastRun":{"runId":"run-old","createdAtMs":1,"phase":"finished","status":"succeeded","target":{"version":"2026.8.1"},"before":{"version":"2026.8.0"},"after":{"version":"2026.8.1"}}}'
      fi
    elif printf '%s\n' "$*" | grep -q -- '--dry-run'; then
      target=2026.8.2
      [ "${FAKE_DRY_TARGET_MISMATCH:-0}" != 1 ] || target=2026.8.9
      printf '{"dryRun":true,"root":"/fake","installKind":"package","mode":"npm","updateInstallKind":"package","switchToGit":false,"switchToPackage":false,"restart":true,"requestedChannel":null,"storedChannel":"stable","effectiveChannel":"stable","tag":"%s","currentVersion":"%s","targetVersion":"%s","downgradeRisk":false,"actions":[],"notes":[]}\n' "$target" "$(cat "$FAKE_STATE")" "$target"
    else
      if [ "${FAKE_UPDATE_UNSAFE:-0}" = 1 ]; then
        echo '{"runId":"run-unsafe","status":"error","mode":"npm","reason":"unsafe","before":{"version":"2026.8.1"},"recovery":{"serviceRestartSafe":false},"steps":[],"durationMs":1}'
        exit 1
      fi
      if [ "${FAKE_UPDATE_HANDOFF_SUCCESS:-0}" = 1 ]; then
        echo '{"runId":"run-handoff","status":"skipped","mode":"npm","reason":"managed-service-handoff-started","before":{"version":"2026.8.1"},"steps":[],"durationMs":1}'
        exit 1
      fi
      if [ "${FAKE_UPDATE_HANDOFF_UNSAFE:-0}" = 1 ]; then
        echo '{"runId":"run-handoff-unsafe","status":"skipped","mode":"npm","reason":"managed-service-handoff-started","before":{"version":"2026.8.1"},"steps":[],"durationMs":1}'
        exit 1
      fi
      if [ "${FAKE_UPDATE_HANDOFF_UNSAFE_NO_AFTER:-0}" = 1 ]; then
        echo '{"runId":"run-handoff-unsafe-no-after","status":"skipped","mode":"npm","reason":"managed-service-handoff-started","before":{"version":"2026.8.1"},"steps":[],"durationMs":1}'
        exit 1
      fi
      if [ "${FAKE_UPDATE_NO_RUN_ID:-0}" = 1 ]; then
        echo '{"status":"skipped","mode":"npm","reason":"managed-service-handoff-started","before":{"version":"2026.8.1"},"steps":[],"durationMs":1}'
        exit 1
      fi
      if [ "${FAKE_UPDATE_FAIL:-0}" = 1 ]; then
        echo '{"runId":"run-failed","status":"error","mode":"npm","reason":"fake-failure","before":{"version":"2026.8.1"},"recovery":{"serviceRestartSafe":true},"steps":[],"durationMs":1}'
        exit 1
      fi
      echo 2026.8.2 > "$FAKE_STATE"
      echo '{"status":"ok","mode":"npm","before":{"version":"2026.8.1"},"after":{"version":"2026.8.2"},"recovery":{"serviceRestartSafe":true},"postUpdate":{"plugins":{"status":"ok","changed":false,"sync":{"changed":false,"switchedToBundled":[],"switchedToNpm":[],"warnings":[],"errors":[]},"npm":{"changed":false,"outcomes":[]},"integrityDrifts":[]}},"steps":[],"durationMs":1}'
    fi
    ;;
  backup)
    [ "${2:-}" = create ] || exit 2
    if [ "${FAKE_BACKUP_FAIL:-0}" = 1 ]; then exit 1; fi
    out=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then out=$2; shift 2; else shift; fi
    done
    [ -n "$out" ] || exit 2
    mkdir -p "$out"
    : > "$out/fake-openclaw-backup.tar.gz"
    : > "$FAKE_DF_BACKUP_MARKER"
    echo '{"ok":true}'
    ;;
  plugins)
    case "${2:-}" in
      doctor)
        if [ "${FAKE_PLUGIN_DOCTOR_FAIL:-0}" = 1 ]; then
          echo '{"ok":false,"warnings":[],"errors":["fake plugin failure"]}'
        else
          echo '{"ok":true,"warnings":[],"errors":[]}'
        fi
        ;;
      list)
        if [ "${FAKE_PLUGIN_DRIFT_AFTER_UPDATE:-0}" = 1 ] && [ "$(cat "$FAKE_STATE")" = 2026.8.2 ]; then
          echo '{"plugins":[{"id":"taskctl","enabled":true,"origin":"global","status":"loaded"},{"id":"calendar-analytics","enabled":true,"origin":"global","status":"loaded"},{"id":"codex","enabled":true,"origin":"global","status":"loaded"},{"id":"contacts","enabled":true,"origin":"global","status":"loaded"}]}'
        else
          echo '{"plugins":[{"id":"taskctl","enabled":true,"origin":"global","status":"loaded"},{"id":"calendar-analytics","enabled":true,"origin":"global","status":"loaded"},{"id":"codex","enabled":true,"origin":"global","status":"loaded"},{"id":"contacts","enabled":true,"origin":"global","status":"loaded"},{"id":"investment-analytics","enabled":true,"origin":"global","status":"loaded"},{"id":"telegram","enabled":true,"origin":"bundled","status":"loaded"}]}'
        fi
        ;;
      inspect)
        [ "${3:-}" = codex ] || exit 2
        version=2026.8.2
        [ "${FAKE_CODEX_MISMATCH:-0}" != 1 ] || version=2026.8.1
        printf '{"plugin":{"id":"codex","status":"loaded","version":"%s"},"compatibility":[],"install":{"version":"%s"}}\n' "$version" "$version"
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
SH
chmod 700 "$FAKEBIN/openclaw"

cat > "$FAKEBIN/df" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
avail=${FAKE_DF_AVAIL_KB:-4194304}
if [ "${FAKE_DF_LOW_AFTER_BACKUP:-0}" = 1 ] && [ -e "$FAKE_DF_BACKUP_MARKER" ]; then
  avail=1024
fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/fake 8388608 1 %s 1%% /\n' "$avail"
SH
chmod 700 "$FAKEBIN/df"
cat > "$FAKEBIN/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod 700 "$FAKEBIN/sleep"

export PATH="$FAKEBIN:$PATH"
export FAKE_STATE FAKE_TRACE FAKE_DF_BACKUP_MARKER
export FAKE_STATUS_CALL_COUNTER="$TMP/status-call-counter"
export FAKE_TASK_RESULT_DIR="$TASK_RESULT_DIR"
export FAKE_TASK_CALL_COUNTER="$TMP/task-call-counter"

read_result() { node -e "const v=require(process.argv[1]);process.stdout.write(JSON.stringify(v))" "$1"; }
assert_field() {
  node - "$1" "$2" "$3" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const path=process.argv[3].split('.');let x=v;for(const p of path)x=x?.[p];
const want=JSON.parse(process.argv[4]);if(JSON.stringify(x)!==JSON.stringify(want)){console.error(path.join('.'),x,'!=',want);process.exit(1);}
NODE
}

run_case() {
  local id=$1
  shift
  echo 2026.8.1 > "$FAKE_STATE"
  : > "$FAKE_TRACE"
  rm -f "$FAKE_DF_BACKUP_MARKER" "$FAKE_TASK_CALL_COUNTER" "$FAKE_STATUS_CALL_COUNTER"
  rm -rf "$STATE/executions" "$STATE/recovery/request-$id"
  set +e
  env HOME="$FAKE_HOME" "$@" bash "$WRAPPER" "$id" "$SRC" "$STATE" 2026.8.1 >/dev/null
  CASE_EXIT=$?
  set -e
  CASE_RESULT="$STATE/executions/request-$id.json"
  [ -f "$CASE_RESULT" ]
}

run_case 101
[ "$CASE_EXIT" -eq 0 ]
assert_field "$CASE_RESULT" outcome '"SUCCESS"'
assert_field "$CASE_RESULT" block_further_deployments false
assert_field "$CASE_RESULT" mutation_started true
assert_field "$CASE_RESULT" backup_created true
node - "$CASE_RESULT" <<'NODE'
const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(typeof v.backup_archive!=='string'||!/fake-openclaw-backup\.tar\.gz$/u.test(v.backup_archive)||!/^[0-9a-f]{64}$/u.test(v.backup_sha256||''))process.exit(1);
NODE
assert_field "$CASE_RESULT" core_version '"2026.8.2"'
assert_field "$CASE_RESULT" codex_version '"2026.8.2"'
assert_field "$CASE_RESULT" specialized_runtime_precheck true
assert_field "$CASE_RESULT" specialized_core_acceptance true
assert_field "$CASE_RESULT" specialized_final_acceptance true
assert_field "$CASE_RESULT" specialized_agent_ids '["calendar","engineer","investments","main","tasks"]'
assert_field "$CASE_RESULT" specialized_external_plugin_ids '["calendar-analytics","codex","contacts","investment-analytics","taskctl"]'
assert_field "$CASE_RESULT" task_predeploy_result '"PASS"'
assert_field "$CASE_RESULT" task_predeploy_mutation_started true
assert_field "$CASE_RESULT" task_deploy_result '"PASS"'

run_case 102 FAKE_BACKUP_FAIL=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" mutation_started false
assert_field "$CASE_RESULT" backup_created false
! grep -q '^update --tag 2026.8.2 --json$' "$FAKE_TRACE"

run_case 103 FAKE_BAD_STATUS=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" mutation_started false
! grep -q '^backup create ' "$FAKE_TRACE"

run_case 115 FAKE_ACTIVE_RUN=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" mutation_started false
assert_field "$CASE_RESULT" backup_created false
! grep -q '^backup create ' "$FAKE_TRACE"
! grep -q '^update --tag 2026.8.2 --json$' "$FAKE_TRACE"

run_case 104 FAKE_DRY_TARGET_MISMATCH=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" mutation_started false
! grep -q '^backup create ' "$FAKE_TRACE"

run_case 119 FAKE_PLUGIN_DOCTOR_FAIL=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" mutation_started false
assert_field "$CASE_RESULT" specialized_runtime_precheck false
! grep -q '^backup create ' "$FAKE_TRACE"
! grep -q '^update --tag 2026.8.2 --json$' "$FAKE_TRACE"

run_case 105 FAKE_UPDATE_FAIL=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" mutation_started true
assert_field "$CASE_RESULT" backup_created true
assert_field "$CASE_RESULT" update_run_id '"run-failed"'
assert_field "$CASE_RESULT" update_run_status '"failed"'
assert_field "$CASE_RESULT" update_run_reconciled true

run_case 113 FAKE_UPDATE_HANDOFF_SUCCESS=1
[ "$CASE_EXIT" -eq 0 ]
assert_field "$CASE_RESULT" outcome '"SUCCESS"'
assert_field "$CASE_RESULT" update_run_id '"run-handoff"'
assert_field "$CASE_RESULT" update_run_status '"succeeded"'
assert_field "$CASE_RESULT" update_run_reconciled true
assert_field "$CASE_RESULT" update_command_exit 1
assert_field "$CASE_RESULT" core_version '"2026.8.2"'
assert_field "$CASE_RESULT" specialized_final_acceptance true

run_case 116 FAKE_UPDATE_NO_RUN_ID=1
[ "$CASE_EXIT" -eq 2 ]
assert_field "$CASE_RESULT" outcome '"UNKNOWN"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" update_run_id null
assert_field "$CASE_RESULT" update_run_reconciled false
assert_field "$CASE_RESULT" update_command_exit 1

run_case 117 FAKE_UPDATE_HANDOFF_UNSAFE=1
[ "$CASE_EXIT" -eq 2 ]
assert_field "$CASE_RESULT" outcome '"RECOVERY_REQUIRED"'
assert_field "$CASE_RESULT" update_run_id '"run-handoff-unsafe"'
assert_field "$CASE_RESULT" update_run_status '"succeeded"'
assert_field "$CASE_RESULT" update_run_reconciled true
assert_field "$CASE_RESULT" update_command_exit 1

run_case 118 FAKE_UPDATE_HANDOFF_UNSAFE_NO_AFTER=1
[ "$CASE_EXIT" -eq 2 ]
assert_field "$CASE_RESULT" outcome '"RECOVERY_REQUIRED"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" update_run_id '"run-handoff-unsafe-no-after"'
assert_field "$CASE_RESULT" update_run_status '"failed"'
assert_field "$CASE_RESULT" update_run_reconciled true
assert_field "$CASE_RESULT" update_command_exit 1
assert_field "$CASE_RESULT" core_version '"2026.8.1"'

run_case 114 FAKE_UPDATE_UNSAFE=1
[ "$CASE_EXIT" -eq 2 ]
assert_field "$CASE_RESULT" outcome '"RECOVERY_REQUIRED"'
assert_field "$CASE_RESULT" update_run_reconciled false
assert_field "$CASE_RESULT" update_command_exit 1

run_case 120 FAKE_AGENT_DRIFT_AFTER_UPDATE=1
[ "$CASE_EXIT" -eq 2 ]
assert_field "$CASE_RESULT" outcome '"RECOVERY_REQUIRED"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" mutation_started true
assert_field "$CASE_RESULT" specialized_runtime_precheck true
assert_field "$CASE_RESULT" specialized_core_acceptance false
assert_field "$CASE_RESULT" stage '"SPECIALIZED_CORE_ACCEPTANCE"'

run_case 122 FAKE_AGENT_TOOL_DRIFT_AFTER_UPDATE=1
[ "$CASE_EXIT" -eq 2 ]
assert_field "$CASE_RESULT" outcome '"RECOVERY_REQUIRED"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" mutation_started true
assert_field "$CASE_RESULT" specialized_runtime_precheck true
assert_field "$CASE_RESULT" specialized_core_acceptance false
assert_field "$CASE_RESULT" stage '"SPECIALIZED_CORE_ACCEPTANCE"'

run_case 121 FAKE_PLUGIN_DRIFT_AFTER_UPDATE=1
[ "$CASE_EXIT" -eq 2 ]
assert_field "$CASE_RESULT" outcome '"RECOVERY_REQUIRED"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" mutation_started true
assert_field "$CASE_RESULT" specialized_runtime_precheck true
assert_field "$CASE_RESULT" specialized_core_acceptance false
assert_field "$CASE_RESULT" stage '"SPECIALIZED_CORE_ACCEPTANCE"'

run_case 106 FAKE_CODEX_MISMATCH=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" core_version '"2026.8.2"'
assert_field "$CASE_RESULT" specialized_core_acceptance true

run_case 107 FAKE_TASK_OUTCOME=BLOCKED FAKE_TASK_STAGE=PRECHECK FAKE_TASK_MUTATION=false
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" task_deploy_result '"BLOCKED"'

run_case 111 FAKE_PREDEPLOY_OUTCOME=BLOCKED FAKE_PREDEPLOY_STAGE=PRECHECK FAKE_PREDEPLOY_MUTATION=false
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" task_predeploy_result '"BLOCKED"'
assert_field "$CASE_RESULT" mutation_started false
! grep -q '^update --tag 2026.8.2 --json$' "$FAKE_TRACE"

run_case 112 FAKE_PREDEPLOY_NO_RESULT=1
[ "$CASE_EXIT" -eq 2 ]
assert_field "$CASE_RESULT" outcome '"UNKNOWN"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" mutation_started false
assert_field "$CASE_RESULT" stage '"TASK_PREDEPLOY"'
! grep -q '^update --tag 2026.8.2 --json$' "$FAKE_TRACE"

run_case 108 FAKE_TASK_OUTCOME=BLOCKED FAKE_TASK_STAGE=APPLY FAKE_TASK_MUTATION=true
[ "$CASE_EXIT" -eq 2 ]
assert_field "$CASE_RESULT" outcome '"RECOVERY_REQUIRED"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" task_mutation_started true

run_case 109 FAKE_DF_AVAIL_KB=1024
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" mutation_started false
assert_field "$CASE_RESULT" backup_created false
! grep -q '^backup create ' "$FAKE_TRACE"
! grep -q '^update --tag 2026.8.2 --json$' "$FAKE_TRACE"

run_case 110 FAKE_DF_LOW_AFTER_BACKUP=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" mutation_started false
assert_field "$CASE_RESULT" backup_created true
! grep -q '^update --tag 2026.8.2 --json$' "$FAKE_TRACE"

echo ROLLOUT_WRAPPER_TEST_PASS
