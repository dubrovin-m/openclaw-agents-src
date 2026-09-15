#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
RUNTIME_CONTRACT=""
RUNTIME_HELPER=""
LEGACY_RECOVERY_FORMAT="task-agent-recovery-v1"
MIGRATED_RECOVERY_FORMAT="task-agent-recovery-v2"
LEGACY_WORKSPACE_FILES=(AGENTS.md SOUL.md TOOLS.md USER.md IDENTITY.md HEARTBEAT.md)
MIGRATED_WORKSPACE_FILES=(AGENTS.md SOUL.md USER.md IDENTITY.md HEARTBEAT.md)
EXPECTED_OPENCLAW_VERSION=""

fail() {
  echo "$*" >&2
  exit 2
}

validate_runtime_contract() {
  local contract_root="$REPO_ROOT"
  command -v node >/dev/null 2>&1 || fail "node unavailable for recovery validation"
  if [ -n "${TEST_ROOT:-}" ] && [ -n "${TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT:-}" ]; then
    case "$TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT" in /*) ;; *) fail "TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT must be absolute" ;; esac
    contract_root=$(realpath -e "$TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT") || fail "Unable to resolve test runtime contract root"
  fi
  RUNTIME_CONTRACT="$contract_root/runtime-contract.json"
  RUNTIME_HELPER="$contract_root/shared/runtime-contract/runtime-contract.mjs"
  test -f "$RUNTIME_CONTRACT" || fail "Runtime contract missing: $RUNTIME_CONTRACT"
  test -f "$RUNTIME_HELPER" || fail "Runtime contract helper missing: $RUNTIME_HELPER"
  EXPECTED_OPENCLAW_VERSION=$(node "$RUNTIME_HELPER" openclaw-version "$RUNTIME_CONTRACT") || fail "Runtime contract is invalid"
  node "$RUNTIME_HELPER" check-node "$RUNTIME_CONTRACT" "$(node --version)" >/dev/null || fail "Node runtime is incompatible with the recovery contract"
}

normalize_test_root() {
  local candidate=$1 resolved
  case "$candidate" in /*) ;; *) fail "--test-root must be an absolute path" ;; esac
  test -d "$candidate" || fail "Missing test root: $candidate"
  resolved=$(realpath -e "$candidate")
  case "$resolved" in
    /|/home/dubrovin|/home/dubrovin/.openclaw|/home/dubrovin/.openclaw/*|/home/dubrovin/.local|/home/dubrovin/.local/*|/home/dubrovin/.config/systemd|/home/dubrovin/.config/systemd/*)
      fail "Refusing unsafe test root: $resolved"
      ;;
  esac
  printf '%s\n' "$resolved"
}

verify_archive_prefix() {
  local archive=$1 prefix=$2 entry listing
  listing=$(tar -tvzf "$archive") || fail "Unable to inspect archive: $archive"
  if grep -Eq '^[lh]' <<<"$listing"; then
    fail "Refusing archive with links: $archive"
  fi
  while IFS= read -r entry; do
    case "/$entry/" in */../*) fail "Refusing parent traversal in archive entry: $entry" ;; esac
    case "$entry" in "$prefix"|"$prefix"/*) ;; *) fail "Refusing unexpected archive entry: $entry" ;; esac
  done < <(tar -tzf "$archive")
}

recovery_workspace_files() {
  case "$1" in
    "$LEGACY_RECOVERY_FORMAT") printf '%s\n' "${LEGACY_WORKSPACE_FILES[*]}" ;;
    "$MIGRATED_RECOVERY_FORMAT") printf '%s\n' "${MIGRATED_WORKSPACE_FILES[*]}" ;;
    *) fail "Unsupported recovery format" ;;
  esac
}

recovery_db_schema() {
  node - "$1" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
  const fk=db.prepare('PRAGMA foreign_key_check').all().length;
  const uv=Number(db.prepare('PRAGMA user_version').get().user_version);
  if(integrity!=='ok'||fk!==0||![4,5,6].includes(uv))process.exit(2);
  if(uv===6){const cols=n=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n)?db.prepare(`PRAGMA table_info("${n}")`).all().map(x=>x.name):[];const rec=cols('recurrences'),rl=cols('recurrence_labels'),ro=cols('recurrence_occurrences'),re=cols('recurrence_events');if(!['id','status','mode','title','assignee_id','rule_json','calendar_cursor_date'].every(x=>rec.includes(x))||!['recurrence_id','label_id'].every(x=>rl.includes(x))||!['recurrence_id','occurrence_key','task_id','template_json'].every(x=>ro.includes(x))||!['recurrence_id','event_type','occurred_at'].every(x=>re.includes(x)))process.exit(2);}
  process.stdout.write(String(uv));
} finally {db.close();}
NODE
}

validate_recovery_set() {
  local backup=$1 f expected actual format workspace_files
  test -d "$backup" || fail "Missing recovery set: $backup"
  for f in RECOVERY_FORMAT openclaw.json.before taskctl.before tasks.sqlite3 taskctl-managed.before.tar.gz workspace-tasks.before.tar.gz SHA256SUMS; do
    test -f "$backup/$f" || fail "Missing $f"
  done
  format=$(cat "$backup/RECOVERY_FORMAT")
  workspace_files=$(recovery_workspace_files "$format")
  (cd "$backup" && sha256sum -c SHA256SUMS >/dev/null) || fail "Recovery checksum verification failed"
  for f in RECOVERY_FORMAT openclaw.json.before taskctl.before tasks.sqlite3 taskctl-managed.before.tar.gz workspace-tasks.before.tar.gz; do
    grep -Eq "^[0-9a-f]{64}  ${f//./\\.}$" "$backup/SHA256SUMS" || fail "Recovery checksum manifest is incomplete: $f"
  done
  if [ -f "$backup/calendar-materializer.before.json" ]; then
    grep -Eq "^[0-9a-f]{64}  calendar-materializer\.before\.json$" "$backup/SHA256SUMS" || fail "Recovery checksum manifest is incomplete: calendar-materializer.before.json"
    node - "$backup/calendar-materializer.before.json" <<'NODE' || fail "Recovery calendar materializer snapshot is invalid"
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(x?.format!=='task-agent-calendar-materializer-recovery-v1'||typeof x?.declaration_key!=='string'||!x.declaration_key||!Array.isArray(x?.jobs)||x.jobs.length!==0)process.exit(2);
NODE
  fi

  verify_archive_prefix "$backup/taskctl-managed.before.tar.gz" "taskctl"
  verify_archive_prefix "$backup/workspace-tasks.before.tar.gz" "workspace-tasks"
  expected=$(for f in $workspace_files; do printf 'workspace-tasks/%s\n' "$f"; done | LC_ALL=C sort)
  actual=$(tar -tzf "$backup/workspace-tasks.before.tar.gz" | sed 's#/$##' | grep -v '^workspace-tasks$' | LC_ALL=C sort)
  [ "$actual" = "$expected" ] || fail "Recovery workspace archive contains unexpected entries"

  recovery_db_schema "$backup/tasks.sqlite3" >/dev/null || fail "Recovery database validation failed"
}

resolve_host_openclaw_root() {
  local openclaw_bin=$1 resolved dir pkg name version
  if [ -n "${TEST_ROOT:-}" ] && [ -n "${TASK_AGENT_TEST_OPENCLAW_ROOT:-}" ]; then
    realpath -e "$TASK_AGENT_TEST_OPENCLAW_ROOT"
    return
  fi
  resolved=$(readlink -f "$openclaw_bin") || fail "Unable to resolve OpenClaw executable"
  dir=$(dirname "$resolved")
  while [ "$dir" != "/" ]; do
    pkg="$dir/package.json"
    if [ -f "$pkg" ]; then
      name=$(node -e "const p=require(process.argv[1]);process.stdout.write(String(p.name||''))" "$pkg")
      version=$(node -e "const p=require(process.argv[1]);process.stdout.write(String(p.version||''))" "$pkg")
      if [ "$name" = "openclaw" ]; then
        [ "$version" = "$EXPECTED_OPENCLAW_VERSION" ] || fail "Unexpected host OpenClaw package version: $version (expected $EXPECTED_OPENCLAW_VERSION)"
        realpath -e "$dir"
        return
      fi
    fi
    dir=$(dirname "$dir")
  done
  fail "Unable to locate host OpenClaw package root"
}

reconcile_calendar_materializer_before() {
  local backup=$1 openclaw_bin=$2 home_dir=$3 state_dir=$4 config_path=$5 snapshot="$backup/calendar-materializer.before.json" key current ids id
  [ -f "$snapshot" ] || return 0
  key=$(node -e 'const x=require(process.argv[1]);if(x.format!=="task-agent-calendar-materializer-recovery-v1"||!Array.isArray(x.jobs)||x.jobs.length!==0)process.exit(2);process.stdout.write(x.declaration_key)' "$snapshot") || fail "Recovery materializer snapshot unsupported"
  if [ -n "${TEST_ROOT:-}" ]; then
    current=$(HOME="$home_dir" OPENCLAW_HOME="$home_dir" OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" "$openclaw_bin" automations list --all --json) || fail "Unable to inspect current Automations before recovery"
  else
    current=$("$openclaw_bin" automations list --all --json) || fail "Unable to inspect current Automations before recovery"
  fi
  ids=$(node - "$key" "$current" <<'NODE'
const key=process.argv[2],x=JSON.parse(process.argv[3]),jobs=Array.isArray(x)?x:(Array.isArray(x?.jobs)?x.jobs:[]);for(const j of jobs)if(j?.declarationKey===key&&typeof j?.id==='string')process.stdout.write(j.id+'\n');
NODE
) || fail "Unable to resolve Recurrence materializer jobs"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if [ -n "${TEST_ROOT:-}" ]; then HOME="$home_dir" OPENCLAW_HOME="$home_dir" OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" "$openclaw_bin" automations rm "$id" --json >/dev/null || fail "Failed to remove Recurrence materializer Automation"; else "$openclaw_bin" automations rm "$id" --json >/dev/null || fail "Failed to remove Recurrence materializer Automation"; fi
  done <<<"$ids"
  if [ -n "${TEST_ROOT:-}" ]; then current=$(HOME="$home_dir" OPENCLAW_HOME="$home_dir" OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" "$openclaw_bin" automations list --all --json) || fail "Unable to verify Automations after cleanup"; else current=$("$openclaw_bin" automations list --all --json) || fail "Unable to verify Automations after cleanup"; fi
  node - "$key" "$current" <<'NODE' || fail "Recurrence materializer Automation remains after cleanup"
const key=process.argv[2],x=JSON.parse(process.argv[3]),jobs=Array.isArray(x)?x:(Array.isArray(x?.jobs)?x.jobs:[]);if(jobs.some(j=>j?.declarationKey===key))process.exit(1);
NODE
}

restore_state() {
  local test_root=$1 backup=$2 manage_gateway=$3
  local home_dir state_dir config_path workspace bin_dir taskctl_target db_path plugin_dir openclaw_bin systemctl_bin host_openclaw_root peer_dir peer_link f format workspace_files expected_db_schema
  if [ -n "$test_root" ]; then
    home_dir="$test_root/home"
    state_dir="$test_root/state"
    config_path="$state_dir/openclaw.json"
    workspace="$test_root/workspace-tasks"
    bin_dir="$test_root/bin"
    db_path="$state_dir/data/tasks/tasks.sqlite3"
    plugin_dir="$state_dir/extensions/taskctl"
    openclaw_bin=$(command -v openclaw || true)
    [ -n "$openclaw_bin" ] || openclaw_bin="$ROOT/plugins/taskctl/node_modules/.bin/openclaw"
  else
    home_dir="/home/dubrovin"
    state_dir="$home_dir/.openclaw"
    config_path="$state_dir/openclaw.json"
    workspace="$state_dir/workspace-tasks"
    bin_dir="$home_dir/.local/bin"
    db_path="$state_dir/data/tasks/tasks.sqlite3"
    plugin_dir="$state_dir/extensions/taskctl"
    openclaw_bin=$(command -v openclaw || true)
  fi
  [ -x "$openclaw_bin" ] || fail "openclaw unavailable"
  taskctl_target="$bin_dir/taskctl"
  host_openclaw_root=$(resolve_host_openclaw_root "$openclaw_bin")
  peer_dir="$plugin_dir/node_modules"
  peer_link="$peer_dir/openclaw"
  format=$(cat "$backup/RECOVERY_FORMAT")
  workspace_files=$(recovery_workspace_files "$format")
  expected_db_schema=$(recovery_db_schema "$backup/tasks.sqlite3") || fail "Recovery database validation failed"

  systemctl_bin=""
  if [ "$manage_gateway" -eq 1 ]; then
    systemctl_bin=$(command -v systemctl || true)
    [ -n "$systemctl_bin" ] || fail "systemctl unavailable"
    if [ -f "$backup/calendar-materializer.before.json" ]; then
      if [ -n "$test_root" ]; then
        if ! TASK_AGENT_TEST_ROOT="$test_root" "$systemctl_bin" --user is-active --quiet openclaw-gateway.service; then TASK_AGENT_TEST_ROOT="$test_root" "$systemctl_bin" --user start openclaw-gateway.service || fail "Failed to start test Gateway for Automation recovery"; fi
      else
        if ! "$systemctl_bin" --user is-active --quiet openclaw-gateway.service; then "$systemctl_bin" --user start openclaw-gateway.service || fail "Failed to start Gateway for Automation recovery"; fi
      fi
      reconcile_calendar_materializer_before "$backup" "$openclaw_bin" "$home_dir" "$state_dir" "$config_path"
    fi
    if [ -n "$test_root" ]; then
      TASK_AGENT_TEST_ROOT="$test_root" "$systemctl_bin" --user stop openclaw-gateway.service || fail "Failed to stop test Gateway"
    else
      "$systemctl_bin" --user stop openclaw-gateway.service || fail "Failed to stop Gateway"
    fi
  fi

  install -d -m 700 "$state_dir" "$bin_dir" "$(dirname "$db_path")" "$(dirname "$plugin_dir")" "$workspace"
  install -m 600 "$backup/openclaw.json.before" "$config_path" || fail "Config restore failed"
  install -m 700 "$backup/taskctl.before" "$taskctl_target" || fail "taskctl restore failed"
  rm -f "$db_path-wal" "$db_path-shm"
  install -m 600 "$backup/tasks.sqlite3" "$db_path" || fail "Database restore failed"

  rm -rf "$plugin_dir"
  tar -xzf "$backup/taskctl-managed.before.tar.gz" -C "$(dirname "$plugin_dir")" || fail "Plugin restore failed"
  test -d "$plugin_dir" || fail "Plugin directory missing after restore"
  if find "$plugin_dir" -type l -print -quit | grep -q .; then fail "Unexpected symlink in restored plugin archive"; fi
  install -d -m 700 "$peer_dir"
  [ ! -e "$peer_link" ] && [ ! -L "$peer_link" ] || fail "Unexpected OpenClaw peer link after archive extraction"
  ln -s "$host_openclaw_root" "$peer_link" || fail "OpenClaw peer link recreation failed"
  [ "$(readlink -f "$peer_link")" = "$host_openclaw_root" ] || fail "OpenClaw peer link target mismatch"

  for f in "${LEGACY_WORKSPACE_FILES[@]}"; do rm -f "$workspace/$f"; done
  tar -xzf "$backup/workspace-tasks.before.tar.gz" -C "$(dirname "$workspace")" || fail "Workspace restore failed"
  for f in $workspace_files; do
    test -f "$workspace/$f" || fail "Missing restored workspace file: $f"
    chmod 644 "$workspace/$f"
  done
  if [ "$format" = "$MIGRATED_RECOVERY_FORMAT" ]; then
    [ ! -e "$workspace/TOOLS.md" ] || fail "Retired TOOLS.md unexpectedly restored"
  fi
  chmod 600 "$config_path" "$db_path"
  chmod 700 "$taskctl_target" "$plugin_dir"

  if [ -n "$test_root" ]; then
    HOME="$home_dir" OPENCLAW_HOME="$home_dir" OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" "$openclaw_bin" config validate || fail "Restored config invalid"
    TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$db_path" "$taskctl_target" health >/dev/null || fail "Restored taskctl health failed"
  else
    "$openclaw_bin" config validate || fail "Restored config invalid"
    "$taskctl_target" health >/dev/null || fail "Restored taskctl health failed"
  fi

  node - "$db_path" "$expected_db_schema" <<'NODE' || fail "Restored database failed integrity validation"
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const expected=Number(process.argv[3]);
  if(Number(db.prepare('PRAGMA user_version').get().user_version)!==expected)process.exit(2);
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length!==0)process.exit(2);
} finally {db.close();}
NODE

  if [ "$manage_gateway" -eq 1 ]; then
    if [ -n "$test_root" ]; then
      TASK_AGENT_TEST_ROOT="$test_root" "$systemctl_bin" --user start openclaw-gateway.service || fail "Failed to start test Gateway"
      TASK_AGENT_TEST_ROOT="$test_root" "$systemctl_bin" --user is-active --quiet openclaw-gateway.service || fail "Test Gateway not active after recovery"
    else
      "$systemctl_bin" --user start openclaw-gateway.service || fail "Failed to start Gateway"
      "$systemctl_bin" --user is-active --quiet openclaw-gateway.service || fail "Gateway not active after recovery"
    fi
  fi
  printf 'TASK_AGENT_RECOVERY_APPLIED\n'
}

TEST_ROOT=""
APPLY=0
INSPECT=0
CONFIRM=0
BACKUP=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --test-root) [ "$#" -ge 2 ] || fail "Missing --test-root value"; TEST_ROOT=$2; shift 2 ;;
    --from) [ "$#" -ge 2 ] || fail "Missing --from value"; BACKUP=$2; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --inspect) INSPECT=1; shift ;;
    --confirm-outage) CONFIRM=1; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[ -n "$BACKUP" ] || fail "Usage: $0 [--test-root /absolute/path] [--inspect | --apply --confirm-outage] --from /absolute/recovery-set"
case "$BACKUP" in /*) ;; *) fail "--from must be absolute" ;; esac
[ "$APPLY" -eq 0 ] || [ "$INSPECT" -eq 0 ] || fail "--inspect and --apply are mutually exclusive"

validate_runtime_contract
if [ -n "$TEST_ROOT" ]; then
  TEST_ROOT=$(normalize_test_root "$TEST_ROOT")
  BACKUP=$(realpath -e "$BACKUP")
else
  case "$BACKUP" in /home/dubrovin/.openclaw/backups/task-agent-stage-*) ;; *) fail "Refusing unexpected production backup path" ;; esac
fi
validate_recovery_set "$BACKUP"

if [ -n "$TEST_ROOT" ] && [ "$APPLY" -eq 0 ] && [ "$INSPECT" -eq 0 ]; then
  restore_state "$TEST_ROOT" "$BACKUP" 0
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo "Recovery artifacts verified at $BACKUP."
  echo "Database/config/plugin/workspace restoration requires --apply --confirm-outage and is intentionally not automatic."
  exit 3
fi
[ "$CONFIRM" -eq 1 ] || fail "Recovery apply requires --confirm-outage"
restore_state "$TEST_ROOT" "$BACKUP" 1
