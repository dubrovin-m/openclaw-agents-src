#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN_REGISTRY_HELPER="$ROOT/production-control/plugin-registry-state.cjs"
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel) || { echo "repository root unavailable" >&2; exit 2; }
TMP=$(mktemp -d /tmp/task-agent-workspace-retirement.XXXXXX)
# Keep npm cache outside disposable runtime fixtures. CI setup/npm steps and local
# qualification can reuse the host cache, while cloned runtime/recovery state
# remains independent of npm scratch data.
export npm_config_cache="${TASK_AGENT_TEST_NPM_CACHE:-$HOME/.npm}"
cleanup(){ rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

fail(){ echo "$*" >&2; exit 2; }

RELEASE_ENV=$(node - "$ROOT/release.json" <<'NODE'
const fs=require('fs');
const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const files=['AGENTS.md','SOUL.md','TOOLS.md','USER.md','IDENTITY.md','HEARTBEAT.md'];
const bad=m=>{console.error(m);process.exit(2)};
if(r?.format!=='task-agent-release-v2')bad('unexpected release format');
const from=r?.from;
if(!from||from.taskctl_versions?.length!==1||from.plugin_versions?.length!==1||from.sqlite_schemas?.length!==1)bad('workspace retirement fixture requires one declared predecessor');
if(!from.workspace_sha256||!files.every(f=>/^[0-9a-f]{64}$/.test(from.workspace_sha256[f]||'')))bad('declared predecessor workspace fingerprints unavailable');
if(!/^[0-9a-f]{64}$/.test(from.tools_sha256||''))bad('declared predecessor tools fingerprint unavailable');
const q=s=>`'${String(s).replace(/'/g,"'\\''")}'`;
console.log(`PREDECESSOR_TASKCTL_VERSION=${q(from.taskctl_versions[0])}`);
console.log(`PREDECESSOR_PLUGIN_VERSION=${q(from.plugin_versions[0])}`);
console.log(`PREDECESSOR_SCHEMA=${q(from.sqlite_schemas[0])}`);
console.log(`TARGET_PLUGIN_VERSION=${q(r.plugin.version)}`);
console.log(`EXPECTED_TOOLS_SHA=${q(from.tools_sha256)}`);
for(const f of files)console.log(`EXPECTED_${f.replace(/\./g,'_').toUpperCase()}_SHA=${q(from.workspace_sha256[f])}`);
NODE
) || fail "invalid release predecessor metadata"
eval "$RELEASE_ENV"

PREDECESSOR_VERIFY_JSON=$(node "$ROOT/production-control/verify-release-predecessor.mjs" HEAD^ 2>&1) || fail "release predecessor verification failed: $PREDECESSOR_VERIFY_JSON"
PROVENANCE_MODE=$(node -e 'const x=JSON.parse(process.argv[1]);if(typeof x.provenance_mode!=="string")process.exit(2);process.stdout.write(x.provenance_mode)' "$PREDECESSOR_VERIFY_JSON") || fail "release predecessor verification returned invalid evidence"
if [ "$PROVENANCE_MODE" = "public-bootstrap-bridge" ]; then
  echo TASK_AGENT_WORKSPACE_RETIREMENT_PUBLIC_BOOTSTRAP_BRIDGE_PASS
  exit 0
fi
[ "$PROVENANCE_MODE" = "history" ] || fail "workspace retirement requires historical predecessor provenance"

PREDECESSOR_ARTIFACT="$TMP/openclaw-plugin-taskctl-${PREDECESSOR_PLUGIN_VERSION}.tgz"
PREDECESSOR_SHA_FILE="${PREDECESSOR_ARTIFACT%.tgz}.sha256"
FIXTURE="$TMP/predecessor-source"
mkdir -p "$FIXTURE/workspace" "$FIXTURE/config"

materialize_raw_sha(){
  local path=$1 expected=$2 out=$3 rev candidate="$TMP/candidate.raw"
  while IFS= read -r rev; do
    git -C "$REPO_ROOT" show "$rev:$path" > "$candidate" 2>/dev/null || continue
    if [ "$(sha256sum "$candidate"|awk '{print $1}')" = "$expected" ]; then
      install -m 644 "$candidate" "$out"
      return 0
    fi
  done < <(git -C "$REPO_ROOT" log --format=%H --all -- "$path")
  fail "unable to materialize historical source for $path ($expected)"
}

json_stable_sha(){
  node - "$1" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';
process.stdout.write(crypto.createHash('sha256').update(stable(v)).digest('hex'));
NODE
}

materialize_tools(){
  local path=agents/tasks/config/tasks-tools.json rev candidate="$TMP/candidate-tools.json"
  while IFS= read -r rev; do
    git -C "$REPO_ROOT" show "$rev:$path" > "$candidate" 2>/dev/null || continue
    if [ "$(json_stable_sha "$candidate" 2>/dev/null || true)" = "$EXPECTED_TOOLS_SHA" ]; then
      install -m 644 "$candidate" "$FIXTURE/config/tasks-tools.json"
      return 0
    fi
  done < <(git -C "$REPO_ROOT" log --format=%H --all -- "$path")
  fail "unable to materialize declared predecessor Task tool policy"
}

materialize_taskctl(){
  local path=agents/tasks/taskctl rev candidate="$TMP/candidate-taskctl" identity
  while IFS= read -r rev; do
    git -C "$REPO_ROOT" show "$rev:$path" > "$candidate" 2>/dev/null || continue
    identity=$(node - "$candidate" <<'NODE' 2>/dev/null || true
const fs=require('fs'),s=fs.readFileSync(process.argv[2],'utf8');
const v=s.match(/IMPLEMENTATION_VERSION\s*=\s*['"]([^'"]+)['"]/),q=s.match(/SCHEMA_VERSION\s*=\s*(\d+)/);
if(v&&q)process.stdout.write(`${v[1]} ${q[1]}`);
NODE
)
    if [ "$identity" = "$PREDECESSOR_TASKCTL_VERSION $PREDECESSOR_SCHEMA" ]; then
      install -m 700 "$candidate" "$FIXTURE/taskctl"
      return 0
    fi
  done < <(git -C "$REPO_ROOT" log --format=%H --all -- "$path")
  fail "unable to materialize declared predecessor taskctl"
}

materialize_raw_sha agents/tasks/workspace/AGENTS.md "$EXPECTED_AGENTS_MD_SHA" "$FIXTURE/workspace/AGENTS.md"
materialize_raw_sha agents/tasks/workspace/SOUL.md "$EXPECTED_SOUL_MD_SHA" "$FIXTURE/workspace/SOUL.md"
materialize_raw_sha agents/tasks/workspace/TOOLS.md "$EXPECTED_TOOLS_MD_SHA" "$FIXTURE/workspace/TOOLS.md"
materialize_raw_sha agents/tasks/workspace/USER.md "$EXPECTED_USER_MD_SHA" "$FIXTURE/workspace/USER.md"
materialize_raw_sha agents/tasks/workspace/IDENTITY.md "$EXPECTED_IDENTITY_MD_SHA" "$FIXTURE/workspace/IDENTITY.md"
materialize_raw_sha agents/tasks/workspace/HEARTBEAT.md "$EXPECTED_HEARTBEAT_MD_SHA" "$FIXTURE/workspace/HEARTBEAT.md"
materialize_tools
materialize_taskctl

artifact_rel="agents/tasks/artifacts/openclaw-plugin-taskctl-${PREDECESSOR_PLUGIN_VERSION}.tgz"
sidecar_rel="agents/tasks/artifacts/openclaw-plugin-taskctl-${PREDECESSOR_PLUGIN_VERSION}.sha256"
materialized=0
while IFS= read -r rev; do
  git -C "$REPO_ROOT" show "$rev:$artifact_rel" > "$PREDECESSOR_ARTIFACT" 2>/dev/null || continue
  git -C "$REPO_ROOT" show "$rev:$sidecar_rel" > "$PREDECESSOR_SHA_FILE" 2>/dev/null || continue
  PREDECESSOR_ARTIFACT_SHA=$(sha256sum "$PREDECESSOR_ARTIFACT"|awk '{print $1}')
  if [ "$(awk 'NF{print $1;exit}' "$PREDECESSOR_SHA_FILE")" = "$PREDECESSOR_ARTIFACT_SHA" ]; then
    materialized=1
    break
  fi
done < <(git -C "$REPO_ROOT" log --format=%H --all -- "$artifact_rel")
[ "$materialized" -eq 1 ] || fail "unable to materialize declared predecessor plugin artifact from Git history"
PREDECESSOR_ARTIFACT_SHA=$(sha256sum "$PREDECESSOR_ARTIFACT"|awk '{print $1}')
test "$(awk 'NF{print $1;exit}' "$PREDECESSOR_SHA_FILE")" = "$PREDECESSOR_ARTIFACT_SHA" || fail "predecessor plugin sidecar mismatch"
if tar -xOf "$PREDECESSOR_ARTIFACT" package/dist/plugin.js | grep -q 'task_production_control'; then
  fail "predecessor artifact unexpectedly contains semantic production control"
fi
for f in AGENTS.md SOUL.md TOOLS.md USER.md IDENTITY.md HEARTBEAT.md; do
  var="EXPECTED_${f//./_}"; var="${var^^}_SHA"
  test "$(sha256sum "$FIXTURE/workspace/$f"|awk '{print $1}')" = "${!var}" || fail "materialized predecessor workspace mismatch: $f"
done
test "$(json_stable_sha "$FIXTURE/config/tasks-tools.json")" = "$EXPECTED_TOOLS_SHA" || fail "materialized predecessor tools mismatch"
test "$(sha256sum "$ROOT/workspace/TOOLS.md"|awk '{print $1}')" = "$EXPECTED_TOOLS_MD_SHA" || fail "current retired TOOLS.md source no longer matches declared migration provenance"
test "$(node "$ROOT/workspace-layout.mjs" layout "$ROOT/release.json")" = agents-md-tools-v1 || fail "unexpected workspace layout"
test "$(node "$ROOT/workspace-layout.mjs" recovery-format "$ROOT/release.json")" = task-agent-recovery-v4 || fail "unexpected recovery format"

OPENCLAW_BIN=$(command -v openclaw || true)
[ -n "$OPENCLAW_BIN" ] || OPENCLAW_BIN="$ROOT/plugins/taskctl/node_modules/.bin/openclaw"
[ -x "$OPENCLAW_BIN" ] || fail "OpenClaw binary unavailable"
OPENCLAW_ROOT=$(node - "$OPENCLAW_BIN" <<'NODE'
const fs=require('fs'),path=require('path');let p=fs.realpathSync(process.argv[2]);let d=path.dirname(p);while(d!=='/'){const f=path.join(d,'package.json');if(fs.existsSync(f)){const j=JSON.parse(fs.readFileSync(f,'utf8'));if(j.name==='openclaw'){process.stdout.write(d);process.exit(0)}}d=path.dirname(d)}process.exit(2);
NODE
) || fail "OpenClaw package root unavailable"
export TASK_AGENT_TEST_OPENCLAW_ROOT="$OPENCLAW_ROOT"
export TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT="$(cd "$ROOT/../.." && pwd)"

mkdir -p "$TMP/shims"
ln -s "$OPENCLAW_BIN" "$TMP/shims/openclaw-real"
cat > "$TMP/shims/openclaw" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = automations ]; then
  STATE=${OPENCLAW_STATE_DIR:?}
  f="$STATE/automations-test.json"
  [ -f "$f" ] || printf '{"jobs":[]}\n' > "$f"
  if [ "${2:-}" = status ]; then
    ROOT_STATE=$(dirname "$STATE")
    [ -f "$ROOT_STATE/gateway.state" ] && [ "$(cat "$ROOT_STATE/gateway.state")" = active ] || exit 2
    echo '{"enabled":true}'
    exit 0
  fi
  if [ "${2:-}" = list ]; then cat "$f"; exit 0; fi
  if [ "${2:-}" = add ]; then
    node - "$f" "${@:3}" <<'NODE'
const fs=require('fs'),p=process.argv[2],a=process.argv.slice(3),opt=n=>{const i=a.indexOf(n);return i>=0?a[i+1]:undefined};
const current=JSON.parse(fs.readFileSync(p,'utf8')),key=opt('--declaration-key'),jobs=current.jobs||[];
if(jobs.some(j=>j.declarationKey===key))process.exit(2);
const job={id:'recurrence-job-1',declarationKey:key,name:opt('--name'),enabled:true,agentId:opt('--agent'),schedule:{kind:'cron',expr:opt('--cron'),tz:opt('--tz'),staggerMs:a.includes('--exact')?0:undefined},sessionTarget:opt('--session')||'isolated',wakeMode:'now',payload:{kind:'command',argv:JSON.parse(opt('--command-argv')),timeoutSeconds:Number(opt('--timeout-seconds'))},delivery:{mode:a.includes('--no-deliver')?'none':'announce'}};
fs.writeFileSync(p,JSON.stringify({jobs:[...jobs,job]})+'\n');process.stdout.write(JSON.stringify({created:true,job})+'\n');
NODE
    exit 0
  fi
  if [ "${2:-}" = rm ] || [ "${2:-}" = remove ]; then
    node - "$f" "$3" <<'NODE'
const fs=require('fs'),p=process.argv[2],id=process.argv[3],x=JSON.parse(fs.readFileSync(p,'utf8'));x.jobs=(x.jobs||[]).filter(j=>j.id!==id);fs.writeFileSync(p,JSON.stringify(x)+'\n');process.stdout.write(JSON.stringify({ok:true,removed:true})+'\n');
NODE
    exit 0
  fi
  exit 2
fi
exec "$(dirname "$0")/openclaw-real" "$@"
SH
chmod 755 "$TMP/shims/openclaw"
cat > "$TMP/shims/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
R=${TASK_AGENT_TEST_ROOT:?}
[ "${1:-}" = --user ] && shift
case "$1" in
  stop) echo inactive > "$R/gateway.state" ;;
  start) echo active > "$R/gateway.state" ;;
  is-active) [ "${2:-}" = --quiet ] && shift; [ "$(cat "$R/gateway.state")" = active ] || exit 3 ;;
  *) exit 2 ;;
esac
SH
chmod 755 "$TMP/shims/systemctl"
export PATH="$TMP/shims:$ROOT/plugins/taskctl/node_modules/.bin:$(dirname "$(command -v node)"):/usr/bin:/bin"

oc_for_root(){
  local r=$1; shift
  HOME="$r/home" OPENCLAW_HOME="$r/home" OPENCLAW_STATE_DIR="$r/state" OPENCLAW_CONFIG_PATH="$r/state/openclaw.json" "$OPENCLAW_BIN" "$@"
}

# Exact Task/OpenClaw source baseline immediately before the 2026.8.2
# supported updater/Doctor migration. This independently proves the migration
# provenance only; later Task batches legitimately changed AGENTS.md again.
OPENCLAW_82_PREUPGRADE_REV=dd8b85d29bd014de6da7dd1f3dc42eec0686a66a

verify_doctor_migration_provenance(){
  local r="$TMP/doctor-derived-predecessor" f var archive doctor_log before_agents_sha doctor_agents_sha bridge_json
  if ! git -C "$REPO_ROOT" cat-file -e "$OPENCLAW_82_PREUPGRADE_REV^{commit}" 2>/dev/null; then
    bridge_json=$(node "$ROOT/tests/verify-public-historical-fixture.mjs" openclaw_82_preupgrade_source_revision "$OPENCLAW_82_PREUPGRADE_REV" HEAD 2>&1) || fail "Doctor historical-fixture bridge verification failed: $bridge_json"
    echo TASK_AGENT_WORKSPACE_RETIREMENT_DOCTOR_PUBLIC_BOOTSTRAP_BRIDGE_PASS
    return 0
  fi
  TASK_AGENT_TEST_PRODUCTION_WORKSPACE_LAYOUT=1 bash "$ROOT/install.sh" --test-root "$r" >/dev/null

  for f in AGENTS.md SOUL.md TOOLS.md USER.md IDENTITY.md HEARTBEAT.md; do
    git -C "$REPO_ROOT" show "$OPENCLAW_82_PREUPGRADE_REV:agents/tasks/workspace/$f" > "$r/workspace-tasks/$f" || fail "unable to materialize pre-upgrade workspace: $f"
    chmod 644 "$r/workspace-tasks/$f"
  done

  # The observed production predecessor retained HEARTBEAT.md (the qualified
  # fcb5ec6 deploy preflight required its exact fingerprint). In OpenClaw 2026.8.2
  # Doctor semantics that corresponds to a disabled heartbeat owner, for which
  # HEARTBEAT.md is retained while the independent TOOLS.md migration still runs.
  oc_for_root "$r" config set 'agents.entries.tasks.heartbeat.every' '"0m"' --strict-json >/dev/null
  oc_for_root "$r" config validate >/dev/null

  before_agents_sha=$(sha256sum "$r/workspace-tasks/AGENTS.md"|awk '{print $1}')
  test "$before_agents_sha" != "$EXPECTED_AGENTS_MD_SHA" || fail "pre-upgrade AGENTS.md is already the declared migrated predecessor"
  test "$(sha256sum "$r/workspace-tasks/TOOLS.md"|awk '{print $1}')" = "$EXPECTED_TOOLS_MD_SHA" || fail "pre-upgrade TOOLS.md does not match declared migration input"
  rm -rf "$r/state/backups/tools-md-migration"

  doctor_log="$TMP/doctor-replay.log"
  if ! oc_for_root "$r" doctor --fix >"$doctor_log" 2>&1; then
    cat "$doctor_log" >&2
    fail "OpenClaw 2026.8.2 Doctor replay failed"
  fi

  test ! -e "$r/workspace-tasks/TOOLS.md" || fail "Doctor replay did not retire TOOLS.md"
  doctor_agents_sha=$(sha256sum "$r/workspace-tasks/AGENTS.md"|awk '{print $1}')
  test "$doctor_agents_sha" != "$before_agents_sha" || fail "Doctor replay did not migrate AGENTS.md"
  archive="$r/state/backups/tools-md-migration/tasks-$EXPECTED_TOOLS_MD_SHA.md"
  test -f "$archive" && test ! -L "$archive" || fail "Doctor replay archive missing or unsafe"
  test "$(sha256sum "$archive"|awk '{print $1}')" = "$EXPECTED_TOOLS_MD_SHA" || fail "Doctor-derived TOOLS.md archive does not match declared predecessor"
  for f in SOUL.md USER.md IDENTITY.md HEARTBEAT.md; do
    var="EXPECTED_${f//./_}"; var="${var^^}_SHA"
    test "$(sha256sum "$r/workspace-tasks/$f"|awk '{print $1}')" = "${!var}" || fail "Doctor replay changed unrelated predecessor workspace file: $f"
  done
}

runtime_tools_sha(){
  node - "$1/state/openclaw.json" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),v=c?.agents?.entries?.tasks?.tools;
if(!v)process.exit(2);const stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';process.stdout.write(crypto.createHash('sha256').update(stable(v)).digest('hex'));
NODE
}

plugin_registry_row_fingerprint(){
  node - "$1/state/state/openclaw.sqlite" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto');const db=new DatabaseSync(process.argv[2],{readOnly:true});try{const r=db.prepare("SELECT value_json,updated_at_ms FROM config_machine_state WHERE state_key='plugins.installedIndex'").get();process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(r??null)).digest('hex'));}finally{db.close();}
NODE
}

assert_predecessor_runtime(){
  local r=$1 health f var
  health=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" "$r/bin/taskctl" health) || fail "predecessor taskctl health changed"
  node -e 'const h=JSON.parse(process.argv[1]);if(h.implementation_version!==process.argv[2]||h.schema_version!==Number(process.argv[3]))process.exit(1)' "$health" "$PREDECESSOR_TASKCTL_VERSION" "$PREDECESSOR_SCHEMA" || fail "predecessor taskctl/schema changed"
  test "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$r/state/extensions/taskctl/package.json")" = "$PREDECESSOR_PLUGIN_VERSION" || fail "predecessor plugin changed"
  for f in AGENTS.md SOUL.md USER.md IDENTITY.md HEARTBEAT.md; do
    var="EXPECTED_${f//./_}"; var="${var^^}_SHA"
    test "$(sha256sum "$r/workspace-tasks/$f"|awk '{print $1}')" = "${!var}" || fail "predecessor workspace changed: $f"
  done
  test "$(runtime_tools_sha "$r")" = "$EXPECTED_TOOLS_SHA" || fail "predecessor tool policy changed"
  node - "$r/state/data/tasks/tasks.sqlite3" "$PREDECESSOR_SCHEMA" <<'NODE' || fail "predecessor DB integrity changed"
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});if(Number(d.prepare('PRAGMA user_version').get().user_version)!==Number(process.argv[3])||d.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||d.prepare('PRAGMA foreign_key_check').all().length!==0)process.exit(1);d.close();
NODE
  node - "$r/state/automations-test.json" <<'NODE' || fail "predecessor unexpectedly retains Recurrence materializer Automation"
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if((x.jobs||[]).length!==0)process.exit(1);
NODE
  test "$(cat "$r/gateway.state")" = active || fail "Gateway state changed"
}

assert_no_contacts_runtime(){
  local r=$1
  test ! -e "$r/state/data/contacts/contacts.sqlite3" || fail "predecessor unexpectedly contains Contacts DB"
  test ! -e "$r/home/.local/lib/openclaw-contacts" || fail "predecessor unexpectedly contains Contacts library"
  test ! -e "$r/bin/contactctl" || fail "predecessor unexpectedly contains contactctl"
  test ! -e "$r/state/extensions/contacts" || fail "predecessor unexpectedly contains Contacts plugin"
  node - "$r/state/openclaw.json" <<'NODE' || fail "predecessor config retains Contacts activation"
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(c?.plugins?.entries?.contacts||c?.plugins?.installs?.contacts||(c?.plugins?.allow||[]).includes('contacts')||Object.prototype.hasOwnProperty.call(c?.agents?.entries?.main??{},'tools'))process.exit(1);
NODE
}

assert_predecessor_restored(){
  local r=$1
  assert_predecessor_runtime "$r"
  assert_no_contacts_runtime "$r"
  test ! -e "$r/workspace-tasks/TOOLS.md" || fail "recovery restored retired TOOLS.md"
}

init_predecessor_runtime(){
  local r=$1 f tools_json
  TASK_AGENT_TEST_PRODUCTION_WORKSPACE_LAYOUT=1 bash "$ROOT/install.sh" --test-root "$r" >/dev/null

  # install.sh creates the current target shape. Strip Shared Contacts so this
  # fixture remains the exact deployed 0.4.9/schema-6 predecessor.
  rm -rf "$r/state/data/contacts" "$r/home/.local/lib/openclaw-contacts" "$r/state/extensions/contacts"
  rm -f "$r/bin/contactctl"
  node - "$r/state/openclaw.json" <<'NODE'
const fs=require('fs'),p=process.argv[2],c=JSON.parse(fs.readFileSync(p,'utf8'));
if(c.plugins?.entries)delete c.plugins.entries.contacts;
if(c.plugins?.installs)delete c.plugins.installs.contacts;
if(Array.isArray(c.plugins?.allow))c.plugins.allow=c.plugins.allow.filter(x=>x!=='contacts');
if(c?.agents?.entries?.main)delete c.agents.entries.main.tools;
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n',{mode:0o600});
NODE

  install -m 700 "$FIXTURE/taskctl" "$r/bin/taskctl"
  rm -f "$r/state/data/tasks/tasks.sqlite3" "$r/state/data/tasks/tasks.sqlite3-wal" "$r/state/data/tasks/tasks.sqlite3-shm"
  TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" "$r/bin/taskctl" init >/dev/null

  for f in AGENTS.md SOUL.md USER.md IDENTITY.md HEARTBEAT.md; do install -m 644 "$FIXTURE/workspace/$f" "$r/workspace-tasks/$f"; done
  rm -f "$r/workspace-tasks/TOOLS.md"

  oc_for_root "$r" plugins install "$PREDECESSOR_ARTIFACT" --force --accept-capabilities >/dev/null
  tools_json=$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))))' "$FIXTURE/config/tasks-tools.json")
  oc_for_root "$r" config set 'agents.entries.tasks.tools' "$tools_json" --strict-json >/dev/null
  oc_for_root "$r" config validate >/dev/null

  mkdir -p "$r/state/backups/tools-md-migration"
  install -m 600 "$FIXTURE/workspace/TOOLS.md" "$r/state/backups/tools-md-migration/tasks-$EXPECTED_TOOLS_MD_SHA.md"
  printf '{"jobs":[]}\n' > "$r/state/automations-test.json"
  echo active > "$r/gateway.state"
  # npm cache is installation scratch state, not part of the runtime fixture.
  # Keeping it in predecessor-base makes every negative-test clone copy
  # hundreds of MB and can exhaust /tmp before the deployment logic runs.
  rm -rf "$r/home/.npm"
  assert_predecessor_restored "$r"
}

clone_predecessor_runtime(){
  local source=$1 target=$2
  cp -a "$source" "$target"
  node - "$target/state/openclaw.json" "$source" "$target" <<'NODE'
const fs=require('fs');
const path=process.argv[2],from=process.argv[3],to=process.argv[4];
const rewrite=v=>typeof v==='string'&&v.startsWith(from)?to+v.slice(from.length):Array.isArray(v)?v.map(rewrite):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rewrite(x)])):v;
const config=rewrite(JSON.parse(fs.readFileSync(path,'utf8')));
fs.writeFileSync(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
NODE
}

expect_preflight_rejection(){
  local r=$1 label=$2 code
  set +e
  HOME="$r/home" bash "$ROOT/deploy.sh" --test-root "$r" --preflight >/dev/null 2>&1
  code=$?
  set -e
  test "$code" -eq 2 || fail "$label was not rejected"
  assert_predecessor_runtime "$r"
}

verify_doctor_migration_provenance
bash "$ROOT/tests/plugin-registry-state.sh"

BASE="$TMP/predecessor-base"
init_predecessor_runtime "$BASE"

# Shared Contacts is activated only by the coordinated schema-6 -> schema-7 cutover.
# A schema-6 predecessor with independently initialized Contacts is outside the
# declared starting fingerprint and must fail before any mutation.
R="$TMP/preinitialized-contacts"
clone_predecessor_runtime "$BASE" "$R"
install -d -m 700 "$R/home/.local/lib/openclaw-contacts" "$R/state/data/contacts"
install -m 600 "$REPO_ROOT/shared/contacts/core.cjs" "$R/home/.local/lib/openclaw-contacts/core.cjs"
install -m 600 "$REPO_ROOT/shared/contacts/task-store.cjs" "$R/home/.local/lib/openclaw-contacts/task-store.cjs"
install -m 700 "$REPO_ROOT/shared/contacts/contactctl" "$R/bin/contactctl"
HOME="$R/home" CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$R/state/data/contacts/contacts.sqlite3" "$R/bin/contactctl" init >/dev/null
oc_for_root "$R" plugins install "$REPO_ROOT/shared/contacts/artifacts/openclaw-plugin-contacts-0.1.2.tgz" --force --accept-capabilities >/dev/null
contacts_before=$(sha256sum "$R/state/data/contacts/contacts.sqlite3"|awk '{print $1}')
expect_preflight_rejection "$R" "schema-6 predecessor with preinitialized Contacts"
test "$(sha256sum "$R/state/data/contacts/contacts.sqlite3"|awk '{print $1}')" = "$contacts_before" || fail "rejected preflight mutated preinitialized Contacts DB"

# The declared OpenClaw 2026.8.2 predecessor must fail closed when
# its Doctor migration provenance is incomplete or the retired file reappears.
R="$TMP/missing-archive"
clone_predecessor_runtime "$BASE" "$R"
rm -f "$R/state/backups/tools-md-migration/tasks-$EXPECTED_TOOLS_MD_SHA.md"
expect_preflight_rejection "$R" "missing retired TOOLS archive"
test ! -e "$R/state/backups/tools-md-migration/tasks-$EXPECTED_TOOLS_MD_SHA.md" || fail "rejected preflight recreated missing retired TOOLS archive"

R="$TMP/wrong-archive"
clone_predecessor_runtime "$BASE" "$R"
printf 'wrong archive\n' > "$R/state/backups/tools-md-migration/tasks-$EXPECTED_TOOLS_MD_SHA.md"
expect_preflight_rejection "$R" "wrong retired TOOLS archive fingerprint"
test "$(cat "$R/state/backups/tools-md-migration/tasks-$EXPECTED_TOOLS_MD_SHA.md")" = "wrong archive" || fail "rejected preflight rewrote wrong retired TOOLS archive"

R="$TMP/symlink-archive"
clone_predecessor_runtime "$BASE" "$R"
rm -f "$R/state/backups/tools-md-migration/tasks-$EXPECTED_TOOLS_MD_SHA.md"
ln -s "$FIXTURE/workspace/TOOLS.md" "$R/state/backups/tools-md-migration/tasks-$EXPECTED_TOOLS_MD_SHA.md"
expect_preflight_rejection "$R" "symlink retired TOOLS archive"
test -L "$R/state/backups/tools-md-migration/tasks-$EXPECTED_TOOLS_MD_SHA.md" || fail "rejected preflight replaced retired TOOLS archive symlink"

R="$TMP/legacy-active-tools"
clone_predecessor_runtime "$BASE" "$R"
install -m 644 "$FIXTURE/workspace/TOOLS.md" "$R/workspace-tasks/TOOLS.md"
expect_preflight_rejection "$R" "legacy six-file active workspace"
test "$(sha256sum "$R/workspace-tasks/TOOLS.md"|awk '{print $1}')" = "$EXPECTED_TOOLS_MD_SHA" || fail "rejected preflight changed legacy active TOOLS.md"

# Exact declared predecessor -> current target.
R="$TMP/success"
clone_predecessor_runtime "$BASE" "$R"
HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --preflight | grep -q 'TASK_AGENT_DEPLOY_PREFLIGHT_PASS' || fail "declared predecessor preflight failed"
PRE_REGISTRY_FINGERPRINT=$(plugin_registry_row_fingerprint "$R")
SUCCESS_LOG="$TMP/success-deploy.log"
set +e
HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --apply >"$SUCCESS_LOG" 2>&1
CODE=$?
set -e
if [ "$CODE" -ne 0 ]; then
  cat "$SUCCESS_LOG" >&2
  RESULT=$(find "$R/deliverables" -name '*-result.json' -type f -print -quit)
  [ -z "$RESULT" ] || cat "$RESULT" >&2
  fail "declared predecessor deploy returned $CODE"
fi
RESULT=$(find "$R/deliverables" -name '*-result.json' -type f -print -quit)
[ -n "$RESULT" ] || fail "deploy result missing"
node - "$RESULT" <<'NODE' || fail "deploy did not complete"
const r=require(process.argv[2]);if(r.result!=='PASS'||r.stage!=='COMPLETE'||r.mutation_started!==true)process.exit(2);
NODE
test "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$R/state/extensions/taskctl/package.json")" = "$TARGET_PLUGIN_VERSION" || fail "target plugin not installed"
node "$PLUGIN_REGISTRY_HELPER" verify-target "$R/state/state/openclaw.sqlite" 2026.8.2 "$TARGET_PLUGIN_VERSION" 0.1.2 || fail "target plugin registry ownership is not exact"
test ! -e "$R/workspace-tasks/TOOLS.md" || fail "target deployment recreated retired TOOLS.md"
RECOVERY=$(find "$R/backups" -maxdepth 1 -type d -name 'task-agent-stage-*' -print -quit)
[ -n "$RECOVERY" ] || fail "v4 recovery set missing"
test "$(cat "$RECOVERY/RECOVERY_FORMAT")" = task-agent-recovery-v4 || fail "wrong recovery format"
test -f "$RECOVERY/plugin-registry.before.json" || fail "v4 recovery set missing plugin registry snapshot"
node "$PLUGIN_REGISTRY_HELPER" validate-snapshot "$RECOVERY/plugin-registry.before.json" || fail "v4 plugin registry snapshot invalid"
node - "$RECOVERY/contacts-state.json" <<'NODE' || fail "v4 predecessor Contacts state is invalid"
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(x.format!=='shared-contacts-recovery-v1'||x.db_present||x.lib_present||x.contactctl_present||x.plugin_present)process.exit(1);
NODE
for f in contacts.sqlite3 contacts-lib.before.tar.gz contactctl.before contacts-plugin.before.tar.gz; do
  test ! -e "$RECOVERY/$f" || fail "v4 recovery retained nonexistent predecessor Contacts artifact: $f"
done

# Recovery v3 was already emitted by the deployed parent implementation. It
# does not contain provider plugin-registry state and must remain inspectable
# under its historical contract after v4 is introduced.
LEGACY_V3="$TMP/legacy-v3-recovery"
cp -a "$RECOVERY" "$LEGACY_V3"
rm -f "$LEGACY_V3/plugin-registry.before.json"
printf '%s\n' task-agent-recovery-v3 > "$LEGACY_V3/RECOVERY_FORMAT"
(
  cd "$LEGACY_V3"
  rm -f SHA256SUMS
  checksum_files=(RECOVERY_FORMAT openclaw.json.before taskctl.before tasks.sqlite3 taskctl-managed.before.tar.gz workspace-tasks.before.tar.gz contacts-state.json)
  [ ! -f calendar-materializer.before.json ] || checksum_files+=(calendar-materializer.before.json)
  sha256sum "${checksum_files[@]}" > SHA256SUMS
)
set +e
bash "$ROOT/recover.sh" --test-root "$R" --inspect --from "$LEGACY_V3" >/dev/null 2>&1
LEGACY_CODE=$?
set -e
test "$LEGACY_CODE" -eq 3 || fail "legacy v3 recovery set is no longer inspectable"

set +e
bash "$ROOT/recover.sh" --test-root "$R" --inspect --from "$RECOVERY" >/dev/null 2>&1
CODE=$?
set -e
test "$CODE" -eq 3 || fail "v4 recovery inspection failed"
bash "$ROOT/recover.sh" --test-root "$R" --apply --confirm-outage --from "$RECOVERY" >/dev/null
assert_predecessor_restored "$R"
test "$(plugin_registry_row_fingerprint "$R")" = "$PRE_REGISTRY_FINGERPRINT" || fail "manual recovery did not restore plugin registry exactly"

# Starting from the verified v3-restored predecessor, a synthetic
# post-mutation fault must automatically roll back to the same declared
# predecessor and must not resurrect retired TOOLS.md.
rm -rf "$R/backups"/task-agent-stage-* "$R/deliverables"
FAULT_LOG="$TMP/rollback-deploy.log"
set +e
TASK_AGENT_DEPLOY_FAULT=after-install HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --apply >"$FAULT_LOG" 2>&1
CODE=$?
set -e
if [ "$CODE" -ne 1 ]; then
  cat "$FAULT_LOG" >&2
  RESULT=$(find "$R/deliverables" -name '*-result.json' -type f -print -quit)
  [ -z "$RESULT" ] || cat "$RESULT" >&2
  fail "faulted deploy returned $CODE instead of successful rollback exit 1"
fi
RESULT=$(find "$R/deliverables" -name '*-result.json' -type f -print -quit)
node - "$RESULT" <<'NODE' || fail "rollback result evidence invalid"
const r=require(process.argv[2]);if(r.result!=='ROLLED_BACK'||r.mutation_started!==true||r.rollback_count!==1)process.exit(2);
NODE
assert_predecessor_restored "$R"
test "$(plugin_registry_row_fingerprint "$R")" = "$PRE_REGISTRY_FINGERPRINT" || fail "automatic rollback did not restore plugin registry exactly"

cleanup
trap - EXIT INT TERM
echo TASK_AGENT_WORKSPACE_RETIREMENT_PASS
