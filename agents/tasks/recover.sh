#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
RUNTIME_CONTRACT=""
RUNTIME_HELPER=""
PLUGIN_REGISTRY_HELPER="$ROOT/production-control/plugin-registry-state.cjs"
CONTACTS_RECOVERY_FORMAT="task-agent-recovery-v4"
CURRENT_WORKSPACE_FILES=(AGENTS.md SOUL.md USER.md IDENTITY.md HEARTBEAT.md)
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
  test -f "$PLUGIN_REGISTRY_HELPER" || fail "Plugin registry state helper missing: $PLUGIN_REGISTRY_HELPER"
  node --check "$PLUGIN_REGISTRY_HELPER" >/dev/null || fail "Plugin registry state helper syntax invalid"
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
  [ "$1" = "$CONTACTS_RECOVERY_FORMAT" ] || fail "Unsupported recovery format"
  printf '%s\n' "${CURRENT_WORKSPACE_FILES[*]}"
}

recovery_db_schema() {
  node - "$1" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
  const fk=db.prepare('PRAGMA foreign_key_check').all().length;
  const uv=Number(db.prepare('PRAGMA user_version').get().user_version);
  if(integrity!=='ok'||fk!==0||uv!==9)process.exit(2);
  const cols=n=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n)?db.prepare(`PRAGMA table_info("${n}")`).all().map(x=>x.name):[];
  const labels=cols('labels'),tasks=cols('tasks'),projects=cols('projects'),ev=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_events'").get()?.sql||'';
  const base=labels.includes('emoji')&&tasks.includes('assignee_id')&&tasks.includes('project_id')&&['id','title','status','created_at','completed_at'].every(x=>projects.includes(x))&&ev.includes('DUE_TIME_CHANGED');
  const rec=cols('recurrences'),rl=cols('recurrence_labels'),ro=cols('recurrence_occurrences'),re=cols('recurrence_events');
  const recurrenceShape=['id','status','mode','title','assignee_id','due_time','target_project_id','rule_json','calendar_cursor_date','created_at','updated_at','cancelled_at'].every(x=>rec.includes(x))&&['recurrence_id','label_id'].every(x=>rl.includes(x))&&['id','recurrence_id','occurrence_key','occurrence_date','predecessor_task_id','task_id','template_json','generated_at'].every(x=>ro.includes(x))&&['id','recurrence_id','event_type','old_value','new_value','reason','occurred_at'].every(x=>re.includes(x));
  const reminders=cols('reminders'),reminderShape=['id','task_id','text','trigger_at','status','close_reason','created_at','closed_at','claim_token','claimed_at','claim_expires_at'].every(x=>reminders.includes(x));
  const bindings=cols('task_domain_bindings'),requests=cols('deadline_change_requests'),governanceShape=['binding_key','entity_id','created_at','updated_at'].every(x=>bindings.includes(x))&&['id','task_id','base_due_date','base_due_time','requested_due_date','requested_due_time','reason','status','approved_due_date','approved_due_time','created_at','resolved_at'].every(x=>requests.includes(x));
  if(!base||!recurrenceShape||cols('people').length!==0||cols('person_aliases').length!==0||!reminderShape||!governanceShape)process.exit(2);
  process.stdout.write('9');
} finally {db.close();}
NODE
}


validate_exact_predecessor_identity() {
  local backup=$1 source taskctl_version task_plugin contacts_version contacts_schema contacts_plugin
  read -r source taskctl_version task_plugin contacts_version contacts_schema contacts_plugin < <(node - "$ROOT/release.json" "$REPO_ROOT/shared/contacts/release.json" <<'NODE'
const task=require(process.argv[2]),contacts=require(process.argv[3]);
const f=task?.from,cf=contacts?.from;
if(!f||!cf||f.source_revision!==cf.source_revision||f.taskctl_versions?.length!==1||f.plugin_versions?.length!==1)process.exit(2);
process.stdout.write([f.source_revision,f.taskctl_versions[0],f.plugin_versions[0],cf.implementation_version,cf.sqlite_schema,cf.plugin_version].join(' ')+'\n');
NODE
  ) || fail "Unable to resolve exact recovery predecessor identity"
  git -C "$REPO_ROOT" cat-file -e "$source^{commit}" 2>/dev/null || fail "Recovery predecessor history is unavailable"

  local expected actual
  expected=$(git -C "$REPO_ROOT" show "$source:agents/tasks/taskctl" | sha256sum | awk '{print $1}') || fail "Unable to fingerprint predecessor taskctl"
  actual=$(sha256sum "$backup/taskctl.before" | awk '{print $1}')
  [ "$actual" = "$expected" ] || fail "Recovery taskctl is not the exact declared predecessor"

  node - "$backup/contacts-state.json" "$contacts_schema" <<'NODE' || fail "Recovery Contacts state is not the exact declared predecessor"
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),schema=Number(process.argv[3]);
if(x.format!=='shared-contacts-recovery-v2'||x.db_present!==true||x.lib_present!==true||x.contactctl_present!==true||x.plugin_present!==true||x.schema_version!==schema)process.exit(2);
NODE

  local predecessor_contacts="$backup/.predecessor-contacts-release.$.json"
  git -C "$REPO_ROOT" show "$source:shared/contacts/release.json" > "$predecessor_contacts" || fail "Unable to materialize predecessor Contacts release"
  node - "$predecessor_contacts" "$contacts_version" "$contacts_schema" "$contacts_plugin" <<'NODE' || { rm -f "$predecessor_contacts"; fail "Predecessor Contacts release identity mismatch"; }
const r=require(process.argv[2]);if(r.implementation_version!==process.argv[3]||r.sqlite_schema!==Number(process.argv[4])||r.plugin?.version!==process.argv[5])process.exit(2);
NODE
  for f in core.cjs task-store.cjs; do
    expected=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.runtime_files[process.argv[2]])' "$predecessor_contacts" "$f") || { rm -f "$predecessor_contacts"; fail "Missing predecessor Contacts fingerprint: $f"; }
    actual=$(tar -xOf "$backup/contacts-lib.before.tar.gz" "openclaw-contacts/$f" | sha256sum | awk '{print $1}') || { rm -f "$predecessor_contacts"; fail "Unable to fingerprint recovered Contacts library: $f"; }
    [ "$actual" = "$expected" ] || { rm -f "$predecessor_contacts"; fail "Recovery Contacts library is not the exact declared predecessor: $f"; }
  done
  expected=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.runtime_files.contactctl)' "$predecessor_contacts")
  actual=$(sha256sum "$backup/contactctl.before" | awk '{print $1}')
  [ "$actual" = "$expected" ] || { rm -f "$predecessor_contacts"; fail "Recovery contactctl is not the exact declared predecessor"; }
  rm -f "$predecessor_contacts"

  actual=$(tar -xOf "$backup/taskctl-managed.before.tar.gz" taskctl/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).version||"")))') || fail "Unable to inspect recovery Task plugin"
  [ "$actual" = "$task_plugin" ] || fail "Recovery Task plugin is not the exact declared predecessor"
  actual=$(tar -xOf "$backup/contacts-plugin.before.tar.gz" contacts/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).version||"")))') || fail "Unable to inspect recovery Contacts plugin"
  [ "$actual" = "$contacts_plugin" ] || fail "Recovery Contacts plugin is not the exact declared predecessor"

  for f in "${CURRENT_WORKSPACE_FILES[@]}"; do
    expected=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.from.workspace_sha256[process.argv[2]]||"")' "$ROOT/release.json" "$f")
    actual=$(tar -xOf "$backup/workspace-tasks.before.tar.gz" "workspace-tasks/$f" | sha256sum | awk '{print $1}') || fail "Unable to fingerprint recovery workspace file: $f"
    [ -n "$expected" ] && [ "$actual" = "$expected" ] || fail "Recovery workspace is not the exact declared predecessor: $f"
  done

  expected=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.from.tools_sha256||"")' "$ROOT/release.json")
  actual=$(node - "$backup/openclaw.json.before" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),v=c?.agents?.entries?.tasks?.tools;
if(!v)process.exit(2);const stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';process.stdout.write(crypto.createHash('sha256').update(stable(v)).digest('hex'));
NODE
  ) || fail "Unable to fingerprint recovery Task tool policy"
  [ "$actual" = "$expected" ] || fail "Recovery Task tool policy is not the exact declared predecessor"

  node - "$backup/tasks.sqlite3" "$backup/contacts.sqlite3" <<'NODE' || fail "Recovery governance bindings are not current"
const {DatabaseSync}=require('node:sqlite'),t=new DatabaseSync(process.argv[2],{readOnly:true}),c=new DatabaseSync(process.argv[3],{readOnly:true});
try{
  const rows=t.prepare("SELECT binding_key,entity_id FROM task_domain_bindings ORDER BY binding_key").all();
  const by=Object.fromEntries(rows.map(x=>[x.binding_key,x.entity_id]));
  if(!Number.isSafeInteger(by.OFFICE_CEO_GROUP)||!Number.isSafeInteger(by.PERSONAL_LABEL))process.exit(2);
  if(!c.prepare('SELECT 1 ok FROM person_groups WHERE id=?').get(by.OFFICE_CEO_GROUP))process.exit(3);
  if(!t.prepare('SELECT 1 ok FROM labels WHERE id=?').get(by.PERSONAL_LABEL))process.exit(4);
  if(Number(c.prepare('PRAGMA user_version').get().user_version)!==3||c.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||c.prepare('PRAGMA foreign_key_check').all().length!==0)process.exit(5);
}finally{t.close();c.close();}
NODE
}

validate_recovery_set() {
  local backup=$1 f expected actual format workspace_files
  test -d "$backup" || fail "Missing recovery set: $backup"
  for f in RECOVERY_FORMAT openclaw.json.before taskctl.before tasks.sqlite3 taskctl-managed.before.tar.gz workspace-tasks.before.tar.gz SHA256SUMS; do
    test -f "$backup/$f" || fail "Missing $f"
  done
  format=$(cat "$backup/RECOVERY_FORMAT")
  [ "$format" = "$CONTACTS_RECOVERY_FORMAT" ] || fail "Unsupported recovery format"
  workspace_files=$(recovery_workspace_files "$format")
  test -f "$backup/contacts-state.json" || fail "Missing contacts-state.json"
  test -f "$backup/plugin-registry.before.json" || fail "Missing plugin-registry.before.json"
  node "$PLUGIN_REGISTRY_HELPER" validate-snapshot "$backup/plugin-registry.before.json" || fail "Plugin registry recovery snapshot is invalid"
  node - "$backup/contacts-state.json" <<'NODE' || fail "Contacts recovery state is invalid"
const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(x?.format!=="shared-contacts-recovery-v2"||typeof x.db_present!=="boolean"||typeof x.lib_present!=="boolean"||typeof x.contactctl_present!=="boolean"||typeof x.plugin_present!=="boolean"||(x.db_present&&(!Number.isSafeInteger(x.schema_version)||x.schema_version<1))||(!x.db_present&&x.schema_version!==null))process.exit(2);
NODE
  (cd "$backup" && sha256sum -c SHA256SUMS >/dev/null) || fail "Recovery checksum verification failed"
  for f in RECOVERY_FORMAT openclaw.json.before taskctl.before tasks.sqlite3 taskctl-managed.before.tar.gz workspace-tasks.before.tar.gz; do
    grep -Eq "^[0-9a-f]{64}  ${f//./\\.}$" "$backup/SHA256SUMS" || fail "Recovery checksum manifest is incomplete: $f"
  done
    grep -Eq "^[0-9a-f]{64}  contacts-state\.json$" "$backup/SHA256SUMS" || fail "Recovery checksum manifest is incomplete: contacts-state.json"
    grep -Eq "^[0-9a-f]{64}  plugin-registry\.before\.json$" "$backup/SHA256SUMS" || fail "Recovery checksum manifest is incomplete: plugin-registry.before.json"
    local cstate; cstate=$(cat "$backup/contacts-state.json")
    if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.db_present?0:1)' "$cstate"; then test -f "$backup/contacts.sqlite3" || fail "Missing Contacts database backup"; grep -Eq "^[0-9a-f]{64}  contacts\.sqlite3$" "$backup/SHA256SUMS" || fail "Missing Contacts database checksum"; fi
    if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.lib_present?0:1)' "$cstate"; then test -f "$backup/contacts-lib.before.tar.gz" || fail "Missing Contacts library backup"; grep -Eq "^[0-9a-f]{64}  contacts-lib\.before\.tar\.gz$" "$backup/SHA256SUMS" || fail "Missing Contacts library checksum"; fi
    if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.contactctl_present?0:1)' "$cstate"; then test -f "$backup/contactctl.before" || fail "Missing contactctl backup"; grep -Eq "^[0-9a-f]{64}  contactctl\.before$" "$backup/SHA256SUMS" || fail "Missing contactctl checksum"; fi
    if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.plugin_present?0:1)' "$cstate"; then test -f "$backup/contacts-plugin.before.tar.gz" || fail "Missing Contacts plugin backup"; grep -Eq "^[0-9a-f]{64}  contacts-plugin\.before\.tar\.gz$" "$backup/SHA256SUMS" || fail "Missing Contacts plugin checksum"; fi

  local cstate; cstate=$(cat "$backup/contacts-state.json")
  if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.lib_present?0:1)' "$cstate"; then verify_archive_prefix "$backup/contacts-lib.before.tar.gz" "openclaw-contacts"; fi
  if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.plugin_present?0:1)' "$cstate"; then verify_archive_prefix "$backup/contacts-plugin.before.tar.gz" "contacts"; fi
  if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.db_present?0:1)' "$cstate"; then
    node - "$backup/contacts.sqlite3" "$backup/contacts-state.json" <<'NODE' || fail "Contacts recovery database validation failed"
const fs=require('fs'),{DatabaseSync}=require('node:sqlite'),state=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),expected=state.schema_version,db=new DatabaseSync(process.argv[2],{readOnly:true});try{if(Number(db.prepare('PRAGMA user_version').get().user_version)!==expected||db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length!==0)process.exit(2);}finally{db.close();}
NODE
  fi
  verify_archive_prefix "$backup/taskctl-managed.before.tar.gz" "taskctl"
  verify_archive_prefix "$backup/workspace-tasks.before.tar.gz" "workspace-tasks"
  expected=$(for f in $workspace_files; do printf 'workspace-tasks/%s\n' "$f"; done | LC_ALL=C sort)
  actual=$(tar -tzf "$backup/workspace-tasks.before.tar.gz" | sed 's#/$##' | grep -v '^workspace-tasks$' | LC_ALL=C sort)
  [ "$actual" = "$expected" ] || fail "Recovery workspace archive contains unexpected entries"

  recovery_db_schema "$backup/tasks.sqlite3" >/dev/null || fail "Recovery database validation failed"
  validate_exact_predecessor_identity "$backup"
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




restore_state() {
  local test_root=$1 backup=$2 manage_gateway=$3
  local home_dir state_dir state_db config_path workspace bin_dir taskctl_target contactctl_target db_path contacts_db contacts_lib contacts_plugin_dir plugin_dir openclaw_bin systemctl_bin host_openclaw_root peer_dir peer_link f format workspace_files expected_db_schema
  if [ -n "$test_root" ]; then
    home_dir="$test_root/home"
    state_dir="$test_root/state"
    config_path="$state_dir/openclaw.json"
    workspace="$test_root/workspace-tasks"
    bin_dir="$test_root/bin"
    db_path="$state_dir/data/tasks/tasks.sqlite3"
    contacts_db="$state_dir/data/contacts/contacts.sqlite3"
    contacts_lib="$home_dir/.local/lib/openclaw-contacts"
    contacts_plugin_dir="$state_dir/extensions/contacts"
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
    contacts_db="$state_dir/data/contacts/contacts.sqlite3"
    contacts_lib="$home_dir/.local/lib/openclaw-contacts"
    contacts_plugin_dir="$state_dir/extensions/contacts"
    plugin_dir="$state_dir/extensions/taskctl"
    openclaw_bin=$(command -v openclaw || true)
  fi
  [ -x "$openclaw_bin" ] || fail "openclaw unavailable"
  state_db="$state_dir/state/openclaw.sqlite"
  taskctl_target="$bin_dir/taskctl"
  contactctl_target="$bin_dir/contactctl"
  host_openclaw_root=$(resolve_host_openclaw_root "$openclaw_bin")
  peer_dir="$plugin_dir/node_modules"
  peer_link="$peer_dir/openclaw"
  format=$(cat "$backup/RECOVERY_FORMAT")
  [ "$format" = "$CONTACTS_RECOVERY_FORMAT" ] || fail "Unsupported recovery format"
  workspace_files=$(recovery_workspace_files "$format")
  expected_db_schema=$(recovery_db_schema "$backup/tasks.sqlite3") || fail "Recovery database validation failed"

  systemctl_bin=""
  if [ "$manage_gateway" -eq 1 ]; then
    systemctl_bin=$(command -v systemctl || true)
    [ -n "$systemctl_bin" ] || fail "systemctl unavailable"
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
  local cstate; cstate=$(cat "$backup/contacts-state.json")
  rm -f "$contacts_db" "$contacts_db-wal" "$contacts_db-shm" "$contactctl_target"; rm -rf "$contacts_lib" "$contacts_plugin_dir"
  if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.db_present?0:1)' "$cstate"; then install -d -m 700 "$(dirname "$contacts_db")"; install -m 600 "$backup/contacts.sqlite3" "$contacts_db" || fail "Contacts database restore failed"; fi
  if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.lib_present?0:1)' "$cstate"; then install -d -m 700 "$(dirname "$contacts_lib")"; tar -xzf "$backup/contacts-lib.before.tar.gz" -C "$(dirname "$contacts_lib")" || fail "Contacts library restore failed"; fi
  if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.contactctl_present?0:1)' "$cstate"; then install -m 700 "$backup/contactctl.before" "$contactctl_target" || fail "contactctl restore failed"; fi
  if node -e 'const x=JSON.parse(process.argv[1]);process.exit(x.plugin_present?0:1)' "$cstate"; then
    tar -xzf "$backup/contacts-plugin.before.tar.gz" -C "$(dirname "$contacts_plugin_dir")" || fail "Contacts plugin restore failed"
    test -d "$contacts_plugin_dir" || fail "Contacts plugin directory missing after restore"
    if find "$contacts_plugin_dir" -type l -print -quit | grep -q .; then fail "Unexpected symlink in restored Contacts plugin archive"; fi
    install -d -m 700 "$contacts_plugin_dir/node_modules"
    ln -s "$host_openclaw_root" "$contacts_plugin_dir/node_modules/openclaw" || fail "Contacts OpenClaw peer link recreation failed"
  fi
  install -m 600 "$backup/tasks.sqlite3" "$db_path" || fail "Database restore failed"

  rm -rf "$plugin_dir"
  tar -xzf "$backup/taskctl-managed.before.tar.gz" -C "$(dirname "$plugin_dir")" || fail "Plugin restore failed"
  test -d "$plugin_dir" || fail "Plugin directory missing after restore"
  if find "$plugin_dir" -type l -print -quit | grep -q .; then fail "Unexpected symlink in restored plugin archive"; fi
  install -d -m 700 "$peer_dir"
  [ ! -e "$peer_link" ] && [ ! -L "$peer_link" ] || fail "Unexpected OpenClaw peer link after archive extraction"
  ln -s "$host_openclaw_root" "$peer_link" || fail "OpenClaw peer link recreation failed"
  [ "$(readlink -f "$peer_link")" = "$host_openclaw_root" ] || fail "OpenClaw peer link target mismatch"

  for f in "${CURRENT_WORKSPACE_FILES[@]}"; do rm -f "$workspace/$f"; done
  tar -xzf "$backup/workspace-tasks.before.tar.gz" -C "$(dirname "$workspace")" || fail "Workspace restore failed"
  for f in $workspace_files; do
    test -f "$workspace/$f" || fail "Missing restored workspace file: $f"
    chmod 644 "$workspace/$f"
  done
  [ ! -e "$workspace/TOOLS.md" ] || fail "Retired TOOLS.md unexpectedly restored"
  chmod 600 "$config_path" "$db_path"
  chmod 700 "$taskctl_target" "$plugin_dir"
  node "$PLUGIN_REGISTRY_HELPER" restore "$state_db" "$backup/plugin-registry.before.json" || fail "Plugin registry restore failed"

  if [ -n "$test_root" ]; then
    HOME="$home_dir" OPENCLAW_HOME="$home_dir" OPENCLAW_STATE_DIR="$state_dir" OPENCLAW_CONFIG_PATH="$config_path" "$openclaw_bin" config validate || fail "Restored config invalid"
    HOME="$home_dir" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$db_path" TASKCTL_CONTACTS_DB="$contacts_db" "$taskctl_target" health >/dev/null || fail "Restored taskctl health failed"
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
