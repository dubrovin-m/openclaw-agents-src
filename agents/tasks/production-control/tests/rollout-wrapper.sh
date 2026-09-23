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
mkdir -p "$SRC/agents/tasks" "$STATE" "$FAKEBIN" "$TASK_RESULT_DIR"

cat > "$SRC/runtime-contract.json" <<'JSON'
{
  "format": "openclaw-agents-runtime-contract-v1",
  "openclaw": { "version": "2026.8.2" },
  "node": { "ci_version": "26.7.0", "supported_lines": [], "required_builtin_modules": [] }
}
JSON
cat > "$SRC/agents/tasks/deploy.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$FAKE_TASK_RESULT_DIR"
RESULT="$FAKE_TASK_RESULT_DIR/result-${RANDOM}.json"
OUTCOME=${FAKE_TASK_OUTCOME:-PASS}
STAGE=${FAKE_TASK_STAGE:-COMPLETE}
MUTATION=${FAKE_TASK_MUTATION:-false}
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
  gateway)
    if [ "${2:-}" = call ] && [ "${3:-}" = update.status ]; then
      if [ "${FAKE_BAD_STATUS:-0}" = 1 ]; then channel=beta; else channel=stable; fi
      printf '{"updateAvailable":{"currentVersion":"%s","latestVersion":"2026.8.2","channel":"latest"},"effectiveChannel":"%s","schedule":{"channel":"%s","autoEnabled":false,"target":{"kind":"package","version":"2026.8.2"}}}\n' "$(cat "$FAKE_STATE")" "$channel" "$channel"
    elif [ "${2:-}" = health ]; then
      [ "${FAKE_HEALTH_FAIL:-0}" != 1 ] || exit 1
      echo '{"ok":true}'
    else
      exit 2
    fi
    ;;
  update)
    if printf '%s\n' "$*" | grep -q -- '--dry-run'; then
      target=2026.8.2
      [ "${FAKE_DRY_TARGET_MISMATCH:-0}" != 1 ] || target=2026.8.9
      printf '{"dryRun":true,"root":"/fake","installKind":"package","mode":"npm","updateInstallKind":"package","switchToGit":false,"switchToPackage":false,"restart":true,"requestedChannel":null,"storedChannel":"stable","effectiveChannel":"stable","tag":"%s","currentVersion":"%s","targetVersion":"%s","downgradeRisk":false,"actions":[],"notes":[]}\n' "$target" "$(cat "$FAKE_STATE")" "$target"
    else
      if [ "${FAKE_UPDATE_FAIL:-0}" = 1 ]; then
        echo '{"status":"error","mode":"npm","reason":"fake-failure","before":{"version":"2026.8.1"},"recovery":{"serviceRestartSafe":true},"steps":[],"durationMs":1}'
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
    [ "${2:-}" = inspect ] && [ "${3:-}" = codex ] || exit 2
    version=2026.8.2
    [ "${FAKE_CODEX_MISMATCH:-0}" != 1 ] || version=2026.8.1
    printf '{"plugin":{"id":"codex","status":"loaded","version":"%s"},"compatibility":[],"install":{"version":"%s"}}\n' "$version" "$version"
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

export PATH="$FAKEBIN:$PATH"
export FAKE_STATE FAKE_TRACE FAKE_DF_BACKUP_MARKER
export FAKE_TASK_RESULT_DIR="$TASK_RESULT_DIR"

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
  rm -f "$FAKE_DF_BACKUP_MARKER"
  rm -rf "$STATE/executions" "$STATE/recovery/request-$id"
  set +e
  env "$@" bash "$WRAPPER" "$id" "$SRC" "$STATE" 2026.8.1 >/dev/null
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

run_case 104 FAKE_DRY_TARGET_MISMATCH=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" mutation_started false
! grep -q '^backup create ' "$FAKE_TRACE"

run_case 105 FAKE_UPDATE_FAIL=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" mutation_started true
assert_field "$CASE_RESULT" backup_created true

run_case 106 FAKE_CODEX_MISMATCH=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" core_version '"2026.8.2"'

run_case 107 FAKE_TASK_OUTCOME=BLOCKED FAKE_TASK_STAGE=PRECHECK FAKE_TASK_MUTATION=false
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" block_further_deployments true
assert_field "$CASE_RESULT" task_deploy_result '"BLOCKED"'

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
! grep -q '^update --tag 2026.8.2 --json
 "$FAKE_TRACE"

run_case 110 FAKE_DF_LOW_AFTER_BACKUP=1
[ "$CASE_EXIT" -eq 1 ]
assert_field "$CASE_RESULT" outcome '"BLOCKED_REQUIRES_JUDGMENT"'
assert_field "$CASE_RESULT" mutation_started false
assert_field "$CASE_RESULT" backup_created true
! grep -q '^update --tag 2026.8.2 --json
 "$FAKE_TRACE"

echo ROLLOUT_WRAPPER_TEST_PASS
