#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUNTIME_CONTRACT="$ROOT/../../runtime-contract.json"
OPENCLAW_VERSION=$(node -e 'const fs=require("fs"),p=process.argv[1],c=JSON.parse(fs.readFileSync(p,"utf8"));if(!c?.openclaw?.version)process.exit(2);process.stdout.write(c.openclaw.version)' "$RUNTIME_CONTRACT")
export TASK_AGENT_TEST_OPENCLAW_VERSION="$OPENCLAW_VERSION"
TMP=$(mktemp -d /tmp/task-agent-release-deploy.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM

FIX="$TMP/repo/agents/tasks"
mkdir -p "$FIX"/{config,workspace,artifacts,plugins/taskctl}
cp "$ROOT/deploy.sh" "$FIX/deploy.sh"
cp "$ROOT/recover.sh" "$FIX/recover.sh"
chmod 755 "$FIX"/{deploy.sh,recover.sh}
for f in SOUL.md TOOLS.md USER.md IDENTITY.md HEARTBEAT.md; do cp "$ROOT/workspace/$f" "$FIX/workspace/$f"; done
printf 'new-agent\n' > "$FIX/workspace/AGENTS.md"

write_taskctl_fixture(){
  local path=$1 version=$2 schema=$3 migrate=${4:-0}
  cat > "$path" <<JS
#!/usr/bin/env node
'use strict';
const {DatabaseSync}=require('node:sqlite');
const IMPLEMENTATION_VERSION = '$version';
const TARGET_SCHEMA = $schema;
if(process.argv[2]==='init'){
  process.stdout.write(JSON.stringify({implementation_version:IMPLEMENTATION_VERSION,schema_version:TARGET_SCHEMA})+'\\n');
} else if(process.argv[2]==='health'){
  const db=new DatabaseSync(process.env.TASKCTL_DB);
  try{
    let v=Number(db.prepare('PRAGMA user_version').get().user_version);
    if ($migrate === 1 && v === 4 && TARGET_SCHEMA === 5) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec("CREATE TABLE projects(id INTEGER PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT); ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT; PRAGMA user_version=5;");
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      v=Number(db.prepare('PRAGMA user_version').get().user_version);
    }
    process.stdout.write(JSON.stringify({implementation_version:IMPLEMENTATION_VERSION,schema_version:v})+'\\n');
    if(v!==TARGET_SCHEMA)process.exitCode=2;
  } finally { db.close(); }
} else process.exitCode=2;
JS
  chmod 755 "$path"
}
write_taskctl_fixture "$FIX/taskctl" 0.4.1 5 1
OLD_TASKCTL="$TMP/taskctl-0.4.0"
write_taskctl_fixture "$OLD_TASKCTL" 0.4.0 4 0
BAD_TASKCTL="$TMP/taskctl-0.4.9"
write_taskctl_fixture "$BAD_TASKCTL" 0.4.9 4 0

cat > "$FIX/config/tasks-tools.json" <<'JSON'
{"profile":"full","allow":["taskctl","task_update","task_complete","task_cancel","read"],"deny":["write","edit","apply_patch","exec","process","browser","gateway"],"fs":{"workspaceOnly":true}}
JSON
cat > "$FIX/plugins/taskctl/package.json" <<'JSON'
{"name":"openclaw-plugin-taskctl","version":"0.4.1","dependencies":{"typebox":"1.3.15"},"devDependencies":{"openclaw":"2026.8.2"},"peerDependencies":{"openclaw":">=2026.8.2"},"openclaw":{"extensions":["./dist/plugin.js"],"compat":{"pluginApi":">=2026.8.2"},"build":{"openclawVersion":"2026.8.2"}}}
JSON
cat > "$FIX/plugins/taskctl/package-lock.json" <<'JSON'
{"name":"openclaw-plugin-taskctl","version":"0.4.1","packages":{"":{"name":"openclaw-plugin-taskctl","version":"0.4.1","dependencies":{"typebox":"1.3.15"},"devDependencies":{"openclaw":"2026.8.2"},"peerDependencies":{"openclaw":">=2026.8.2"}},"node_modules/typebox":{"version":"1.3.15"}}}
JSON
cat > "$FIX/plugins/taskctl/openclaw.plugin.json" <<'JSON'
{"id":"taskctl","version":"0.4.1","contracts":{"tools":["taskctl","task_update","task_complete","task_cancel"]}}
JSON

PKG="$TMP/pkg/package"
mkdir -p "$PKG"
cp "$FIX/plugins/taskctl/package.json" "$PKG/package.json"
tar -czf "$FIX/artifacts/openclaw-plugin-taskctl-0.4.1.tgz" -C "$TMP/pkg" package
ART_SHA=$(sha256sum "$FIX/artifacts/openclaw-plugin-taskctl-0.4.1.tgz"|awk '{print $1}')
printf '%s\n' "$ART_SHA" > "$FIX/artifacts/openclaw-plugin-taskctl-0.4.1.sha256"

OLD_TOOLS='{"profile":"full","allow":["taskctl","read"],"deny":["write","edit","apply_patch","exec","process","browser","gateway"],"fs":{"workspaceOnly":true}}'
stable_json_sha(){
  node -e 'const c=require("crypto"),v=JSON.parse(process.argv[1]);const s=x=>x===null||typeof x!=="object"?JSON.stringify(x):Array.isArray(x)?"["+x.map(s).join(",")+"]":"{"+Object.keys(x).sort().map(k=>JSON.stringify(k)+":"+s(x[k])).join(",")+"}";process.stdout.write(c.createHash("sha256").update(s(v)).digest("hex"))' "$1"
}
OLD_TOOLS_SHA=$(stable_json_sha "$OLD_TOOLS")
OLD_AGENT_SHA=$(printf 'old-agent\n' | sha256sum | awk '{print $1}')
SOUL_SHA=$(sha256sum "$FIX/workspace/SOUL.md"|awk '{print $1}')
TOOLS_SHA=$(sha256sum "$FIX/workspace/TOOLS.md"|awk '{print $1}')
USER_SHA=$(sha256sum "$FIX/workspace/USER.md"|awk '{print $1}')
IDENTITY_SHA=$(sha256sum "$FIX/workspace/IDENTITY.md"|awk '{print $1}')
HEARTBEAT_SHA=$(sha256sum "$FIX/workspace/HEARTBEAT.md"|awk '{print $1}')
cat > "$FIX/release.json" <<JSON
{"format":"task-agent-release-v2","generation":{"taskctl_version":"0.4.1","sqlite_schema":5,"openclaw_build_version":"$OPENCLAW_VERSION","openclaw_compat":">=$OPENCLAW_VERSION","typebox_version":"1.3.15"},"plugin":{"name":"openclaw-plugin-taskctl","version":"0.4.1","artifact":"artifacts/openclaw-plugin-taskctl-0.4.1.tgz","sha256":"$ART_SHA"},"from":{"sqlite_schemas":[4],"taskctl_versions":["0.4.0"],"plugin_versions":["0.4.0"],"workspace_sha256":{"AGENTS.md":"$OLD_AGENT_SHA","SOUL.md":"$SOUL_SHA","TOOLS.md":"$TOOLS_SHA","USER.md":"$USER_SHA","IDENTITY.md":"$IDENTITY_SHA","HEARTBEAT.md":"$HEARTBEAT_SHA"},"tools_sha256":"$OLD_TOOLS_SHA"},"calendar_materializer":{"kind":"openclaw-command-automation-v1","declaration_key":"tasks.recurrence-calendar-materialize.v1","name":"Task Recurrence Calendar Materializer","cron":"0 * * * *","timezone":"Europe/Moscow","exact":true,"timeout_seconds":30}}
JSON

mkdir -p "$TMP/shims" "$TMP/openclaw-package"
printf '{"name":"openclaw","version":"%s"}\n' "$OPENCLAW_VERSION" > "$TMP/openclaw-package/package.json"
cat > "$TMP/shims/openclaw" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
STATE=${OPENCLAW_STATE_DIR:?}
CONFIG=${OPENCLAW_CONFIG_PATH:?}
AUTOMATIONS="$STATE/automations.json"
if [ "${1:-}" = "--version" ]; then echo "openclaw ${TASK_AGENT_TEST_OPENCLAW_VERSION:?}"; exit 0; fi
if [ "${1:-}" = automations ] && [ "${2:-}" = status ]; then
  ROOT_STATE=$(dirname "$STATE")
  [ -f "$ROOT_STATE/gateway.state" ] && [ "$(cat "$ROOT_STATE/gateway.state")" = active ] || exit 2
  COUNT_FILE="$STATE/gateway-ready.count"
  FAILURES_FILE="$STATE/gateway-ready.failures"
  COUNT=0; [ ! -f "$COUNT_FILE" ] || COUNT=$(cat "$COUNT_FILE")
  COUNT=$((COUNT+1)); printf '%s\n' "$COUNT" > "$COUNT_FILE"
  FAILURES=0; [ ! -f "$FAILURES_FILE" ] || FAILURES=$(cat "$FAILURES_FILE")
  [ "$COUNT" -gt "$FAILURES" ] || exit 2
  echo '{"enabled":true}'
  exit 0
fi
if [ "${1:-}" = automations ] && [ "${2:-}" = list ]; then
  [ -f "$AUTOMATIONS" ] || printf '{"jobs":[]}\n' > "$AUTOMATIONS"
  LIST_COUNT_FILE="$STATE/automation-list.count"
  LIST_COUNT=0; [ ! -f "$LIST_COUNT_FILE" ] || LIST_COUNT=$(cat "$LIST_COUNT_FILE")
  LIST_COUNT=$((LIST_COUNT+1)); printf '%s\n' "$LIST_COUNT" > "$LIST_COUNT_FILE"
  if [ "${TASK_AGENT_TEST_MATERIALIZER_CHANGE_AT_LIST:-0}" = "$LIST_COUNT" ] && [ -n "${TASK_AGENT_TEST_MATERIALIZER_CHANGE_ON_LIST:-}" ]; then
    node - "$AUTOMATIONS" "$TASK_AGENT_TEST_MATERIALIZER_CHANGE_ON_LIST" <<'NODE'
const fs=require('fs'),file=process.argv[2],mode=process.argv[3],state=JSON.parse(fs.readFileSync(file,'utf8')),jobs=Array.isArray(state.jobs)?state.jobs:[];
if(mode==='drift'){
  if(jobs.length!==1)process.exit(2);
  jobs[0].schedule.expr='5 * * * *';
} else if(mode==='delete'){
  jobs.splice(0,jobs.length);
} else if(mode==='duplicate'){
  if(jobs.length!==1)process.exit(2);
  const copy=JSON.parse(JSON.stringify(jobs[0]));copy.id='existing-materializer-2';jobs.push(copy);
} else process.exit(2);
fs.writeFileSync(file,JSON.stringify({jobs},null,2)+'\n');
NODE
  fi
  cat "$AUTOMATIONS"
  exit 0
fi
if [ "${1:-}" = automations ] && [ "${2:-}" = add ]; then
  node - "$AUTOMATIONS" "${@:3}" <<'NODE'
const fs=require('fs'),file=process.argv[2],args=process.argv.slice(3);
const value=(flag)=>{const i=args.indexOf(flag);if(i<0||i+1>=args.length)process.exit(2);return args[i+1]};
const key=value('--declaration-key'),name=value('--name'),expr=value('--cron'),tz=value('--tz'),agent=value('--agent'),session=value('--session'),argv=JSON.parse(value('--command-argv')),timeout=Number(value('--timeout-seconds'));
if(!args.includes('--exact')||!args.includes('--no-deliver')||!Number.isSafeInteger(timeout))process.exit(2);
const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{jobs:[]};const jobs=Array.isArray(state.jobs)?state.jobs:[];
if(jobs.some(j=>j?.declarationKey===key))process.exit(2);
const job={id:`job-${jobs.length+1}`,declarationKey:key,name,enabled:true,agentId:agent,schedule:{kind:'cron',expr,tz,staggerMs:0},sessionTarget:session,payload:{kind:'command',argv,timeoutSeconds:timeout},delivery:{mode:'none'}};
jobs.push(job);fs.writeFileSync(file,JSON.stringify({jobs},null,2)+'\n');process.stdout.write(JSON.stringify({created:true,job})+'\n');
NODE
  printf 'add\n' >> "$STATE/automation.ops"
  exit 0
fi
if [ "${1:-}" = automations ] && [ "${2:-}" = rm ]; then
  id=${3:-}
  node - "$AUTOMATIONS" "$id" <<'NODE'
const fs=require('fs'),file=process.argv[2],id=process.argv[3],state=JSON.parse(fs.readFileSync(file,'utf8')),jobs=Array.isArray(state.jobs)?state.jobs:[],next=jobs.filter(j=>j?.id!==id);if(next.length===jobs.length)process.exit(2);fs.writeFileSync(file,JSON.stringify({jobs:next},null,2)+'\n');process.stdout.write(JSON.stringify({removed:true,id})+'\n');
NODE
  printf 'rm:%s\n' "$id" >> "$STATE/automation.ops"
  exit 0
fi
if [ "${1:-}" = config ] && [ "${2:-}" = validate ]; then node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$CONFIG"; exit 0; fi
if [ "${1:-}" = config ] && [ "${2:-}" = set ]; then
  path=$3; value=$4
  if [[ " $* " == *' --dry-run '* ]]; then node -e 'JSON.parse(process.argv[1])' "$value"; exit 0; fi
  node - "$CONFIG" "$path" "$value" <<'NODE'
const fs=require('fs'),p=process.argv[2];if(process.argv[3]!=='agents.entries.tasks.tools')process.exit(2);
const c=JSON.parse(fs.readFileSync(p,'utf8'));if(!c.agents?.entries?.tasks)process.exit(2);
c.agents.entries.tasks.tools=JSON.parse(process.argv[4]);fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');
NODE
  exit 0
fi
if [ "${1:-}" = plugins ] && [ "${2:-}" = install ]; then
  art=$3
  v=$(tar -xOf "$art" package/package.json|node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')
  d="$STATE/extensions/taskctl"; rm -rf "$d"; mkdir -p "$d/node_modules/typebox"
  printf '{"name":"openclaw-plugin-taskctl","version":"%s"}\n' "$v" > "$d/package.json"
  printf '{"name":"typebox","version":"1.3.15"}\n' > "$d/node_modules/typebox/package.json"
  exit 0
fi
if [ "${1:-}" = plugins ] && [ "${2:-}" = inspect ]; then
  echo '{"plugin":{"id":"taskctl"},"tools":["taskctl","task_update","task_complete","task_cancel"]}'
  exit 0
fi
exit 2
SH
chmod 755 "$TMP/shims/openclaw"

cat > "$TMP/shims/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
R=${TASK_AGENT_TEST_ROOT:?}
[ "${1:-}" = --user ] && shift
case "$1" in
  stop) echo inactive > "$R/gateway.state"; echo stop >> "$R/gateway.counts" ;;
  start) echo active > "$R/gateway.state"; echo start >> "$R/gateway.counts" ;;
  is-active) [ "${2:-}" = --quiet ] && shift; [ "$(cat "$R/gateway.state")" = active ] || exit 3 ;;
  *) exit 2 ;;
esac
SH
chmod 755 "$TMP/shims/systemctl"
NODE_DIR=$(dirname "$(command -v node)")
export PATH="$TMP/shims:$NODE_DIR:/usr/bin:/bin"

create_db(){
  mkdir -p "$(dirname "$1")"
  node - "$1" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2]);
d.exec(`
CREATE TABLE labels(id INTEGER PRIMARY KEY,display_name TEXT,created_at TEXT,emoji TEXT);
CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT,assignee_id INTEGER,status TEXT,created_at TEXT);
CREATE TABLE task_events(id INTEGER PRIMARY KEY,task_id INTEGER,event_type TEXT CHECK(event_type IN ('DUE_TIME_CHANGED')));
PRAGMA user_version=4;`);
d.close();
NODE
  chmod 600 "$1"
}

logical_db_fingerprint(){
  node - "$1" <<'NODE'
const {createHash}=require('node:crypto');const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const state={
    user_version:Number(d.prepare('PRAGMA user_version').get().user_version),
    integrity:d.prepare('PRAGMA integrity_check').get().integrity_check,
    fk:d.prepare('PRAGMA foreign_key_check').all(),
    schema:d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  };
  process.stdout.write(createHash('sha256').update(JSON.stringify(state)).digest('hex'));
} finally { d.close(); }
NODE
}

taskctl_runtime_version(){
  local r=$1
  TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" "$r/bin/taskctl" health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).implementation_version))'
}

init_runtime(){
  local r=$1 taskctl_source=${2:-$OLD_TASKCTL}
  rm -rf "$r"
  mkdir -p "$r"/{home,state/extensions/taskctl/node_modules/typebox,state/data/tasks,workspace-tasks,bin,backups,deliverables}
  node - "$r/state/openclaw.json" "$OLD_TOOLS" <<'NODE'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({agents:{entries:{tasks:{tools:JSON.parse(process.argv[3])}}},plugins:{entries:{taskctl:{}},installs:{taskctl:{}}}},null,2)+'\n');
NODE
  chmod 600 "$r/state/openclaw.json"
  cp "$taskctl_source" "$r/bin/taskctl"; chmod 700 "$r/bin/taskctl"
  printf '{"name":"openclaw-plugin-taskctl","version":"0.4.0"}\n' > "$r/state/extensions/taskctl/package.json"
  printf '{"name":"typebox","version":"1.3.15"}\n' > "$r/state/extensions/taskctl/node_modules/typebox/package.json"
  ln -s "$TMP/openclaw-package" "$r/state/extensions/taskctl/node_modules/openclaw"
  printf 'old-agent\n' > "$r/workspace-tasks/AGENTS.md"
  for f in SOUL.md TOOLS.md USER.md IDENTITY.md HEARTBEAT.md; do cp "$FIX/workspace/$f" "$r/workspace-tasks/$f"; done
  chmod 644 "$r/workspace-tasks"/*
  create_db "$r/state/data/tasks/tasks.sqlite3"
  printf '{"jobs":[]}\n' > "$r/state/automations.json"
  : > "$r/state/automation.ops"
  echo active > "$r/gateway.state"; : > "$r/gateway.counts"
}

seed_exact_materializer(){
  local r=$1 count=${2:-1}
  node - "$r/state/automations.json" "$r/bin/taskctl" "$count" <<'NODE'
const fs=require('fs'),file=process.argv[2],taskctl=process.argv[3],count=Number(process.argv[4]);
const make=i=>({id:`existing-materializer-${i}`,declarationKey:'tasks.recurrence-calendar-materialize.v1',name:'Task Recurrence Calendar Materializer',enabled:true,agentId:'tasks',schedule:{kind:'cron',expr:'0 * * * *',tz:'Europe/Moscow',staggerMs:0},sessionTarget:'isolated',payload:{kind:'command',argv:[taskctl,'recurrence','materialize'],timeoutSeconds:30},delivery:{mode:'none'}});
fs.writeFileSync(file,JSON.stringify({jobs:Array.from({length:count},(_,i)=>make(i+1))},null,2)+'\n');
NODE
}

cd "$TMP/repo"
git init -q
git config user.email test@example.com
git config user.name test
git add .
git commit -qm fixture

run(){ local r=$1; HOME="$r/home" TASK_AGENT_TEST_OPENCLAW_ROOT="$TMP/openclaw-package" TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT="$ROOT/../.." "$FIX/deploy.sh" --test-root "$r" --apply; }
preflight(){ local r=$1; HOME="$r/home" TASK_AGENT_TEST_OPENCLAW_ROOT="$TMP/openclaw-package" TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT="$ROOT/../.." "$FIX/deploy.sh" --test-root "$r" --preflight; }

echo STAGE=preflight
R="$TMP/preflight"; init_runtime "$R"
before_counts=$(wc -c < "$R/gateway.counts")
preflight "$R" >/dev/null
test "$(wc -c < "$R/gateway.counts")" = "$before_counts"
test "$(taskctl_runtime_version "$R")" = 0.4.0

echo STAGE=upgrade
R="$TMP/valid"; init_runtime "$R"
BDB=$(sha256sum "$R/state/data/tasks/tasks.sqlite3"|awk '{print $1}')
run "$R" >/dev/null
test "$(taskctl_runtime_version "$R")" = 0.4.1
test "$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$R/state/data/tasks/tasks.sqlite3" "$R/bin/taskctl" health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).schema_version)))')" = 5
cmp -s "$FIX/taskctl" "$R/bin/taskctl"
test "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$R/state/extensions/taskctl/package.json")" = 0.4.1
grep -qx new-agent "$R/workspace-tasks/AGENTS.md"
test "$(sha256sum "$R/state/data/tasks/tasks.sqlite3"|awk '{print $1}')" != "$BDB"
test "$(cat "$R/state/gateway-ready.count")" -eq 1

echo STAGE=gateway-readiness-delay
R="$TMP/gateway-readiness-delay"; init_runtime "$R"
printf '3\n' > "$R/state/gateway-ready.failures"
TASK_AGENT_TEST_GATEWAY_READY_ATTEMPTS=5 TASK_AGENT_TEST_GATEWAY_READY_SLEEP_SECONDS=0.01 run "$R" >/dev/null
test "$(cat "$R/state/gateway-ready.count")" -eq 4
test "$(taskctl_runtime_version "$R")" = 0.4.1
test "$(cat "$R/gateway.state")" = active

echo STAGE=preexisting-materializer
R="$TMP/preexisting-materializer"; init_runtime "$R"; seed_exact_materializer "$R"
MAT_BEFORE=$(sha256sum "$R/state/automations.json"|awk '{print $1}')
preflight "$R" >/dev/null
run "$R" >/dev/null
test "$(sha256sum "$R/state/automations.json"|awk '{print $1}')" = "$MAT_BEFORE"
test ! -s "$R/state/automation.ops"
node -e 'const x=require(process.argv[1]);if(x.jobs?.length!==1||x.jobs[0]?.id!=="existing-materializer-1")process.exit(1)' "$R/state/automations.json"

echo STAGE=preexisting-materializer-rollback
R="$TMP/preexisting-materializer-rollback"; init_runtime "$R"; seed_exact_materializer "$R"
MAT_BEFORE=$(sha256sum "$R/state/automations.json"|awk '{print $1}')
set +e; TASK_AGENT_DEPLOY_FAULT=after-install run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 1
test "$(sha256sum "$R/state/automations.json"|awk '{print $1}')" = "$MAT_BEFORE"
test ! -s "$R/state/automation.ops"
test "$(taskctl_runtime_version "$R")" = 0.4.0

echo STAGE=preexisting-materializer-boundary-change
for CHANGE in drift delete duplicate; do
  R="$TMP/preexisting-materializer-boundary-$CHANGE"; init_runtime "$R"; seed_exact_materializer "$R"
  set +e; TASK_AGENT_TEST_MATERIALIZER_CHANGE_AT_LIST=2 TASK_AGENT_TEST_MATERIALIZER_CHANGE_ON_LIST="$CHANGE" run "$R" >/dev/null 2>&1; C=$?; set -e
  test "$C" -eq 2
  test ! -s "$R/gateway.counts"
  test ! -s "$R/state/automation.ops"
  test "$(taskctl_runtime_version "$R")" = 0.4.0
  test "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$R/state/extensions/taskctl/package.json")" = 0.4.0
  grep -qx old-agent "$R/workspace-tasks/AGENTS.md"
  RESULT=$(find "$R/deliverables" -name '*-result.json' -print -quit)
  node -e 'const x=require(process.argv[1]);if(x.result!=="BLOCKED"||x.stage!=="PREFLIGHT_OUTAGE"||x.mutation_started!==false||x.gateway_stopped!==false||x.rollback_count!==0)process.exit(1)' "$RESULT"
done

echo STAGE=materializer-drift
R="$TMP/materializer-drift"; init_runtime "$R"; seed_exact_materializer "$R"
node -e 'const fs=require("fs"),p=process.argv[1],x=JSON.parse(fs.readFileSync(p));x.jobs[0].schedule.expr="5 * * * *";fs.writeFileSync(p,JSON.stringify(x,null,2)+"\n")' "$R/state/automations.json"
set +e; run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 2
test ! -s "$R/gateway.counts"
test ! -s "$R/state/automation.ops"

echo STAGE=materializer-duplicate
R="$TMP/materializer-duplicate"; init_runtime "$R"; seed_exact_materializer "$R" 2
set +e; run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 2
test ! -s "$R/gateway.counts"
test ! -s "$R/state/automation.ops"

echo STAGE=rollback-after-materializer
R="$TMP/rollback-materializer"; init_runtime "$R"
set +e; TASK_AGENT_DEPLOY_FAULT=after-calendar-materializer run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 1
node -e 'const x=require(process.argv[1]);if(x.jobs?.length!==0)process.exit(1)' "$R/state/automations.json"
test "$(taskctl_runtime_version "$R")" = 0.4.0
test "$(cat "$R/gateway.state")" = active

echo STAGE=gateway-readiness-timeout
R="$TMP/gateway-readiness-timeout"; init_runtime "$R"
BDB=$(logical_db_fingerprint "$R/state/data/tasks/tasks.sqlite3")
printf '10\n' > "$R/state/gateway-ready.failures"
set +e; TASK_AGENT_TEST_GATEWAY_READY_ATTEMPTS=3 TASK_AGENT_TEST_GATEWAY_READY_SLEEP_SECONDS=0.01 run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 1
test "$(cat "$R/state/gateway-ready.count")" -eq 3
test "$(taskctl_runtime_version "$R")" = 0.4.0
test "$(logical_db_fingerprint "$R/state/data/tasks/tasks.sqlite3")" = "$BDB"
test "$(cat "$R/gateway.state")" = active
RESULT=$(find "$R/deliverables" -name '*-result.json' -print -quit)
node -e 'const x=require(process.argv[1]);if(x.result!=="ROLLED_BACK"||x.stage!=="POST_RESTART"||x.mutation_started!==true||x.rollback_count!==1)process.exit(1)' "$RESULT"

echo STAGE=drift
R="$TMP/drift"; init_runtime "$R"
printf 'tampered\n' > "$R/workspace-tasks/AGENTS.md"
set +e; run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 2
test ! -s "$R/gateway.counts"
test "$(taskctl_runtime_version "$R")" = 0.4.0
test "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$R/state/extensions/taskctl/package.json")" = 0.4.0

echo STAGE=bad-predecessor
R="$TMP/badpred"; init_runtime "$R" "$BAD_TASKCTL"
set +e; run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 2
test ! -s "$R/gateway.counts"
test "$(taskctl_runtime_version "$R")" = 0.4.9
test "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$R/state/extensions/taskctl/package.json")" = 0.4.0

echo STAGE=bad-generation
R="$TMP/badgen"; init_runtime "$R"; cp "$FIX/release.json" "$TMP/release.good"
node -e 'const fs=require("fs"),p=process.argv[1],r=JSON.parse(fs.readFileSync(p));r.generation.sqlite_schema=6;fs.writeFileSync(p,JSON.stringify(r))' "$FIX/release.json"
git add agents/tasks/release.json; git commit -qm 'bad generation fixture'
set +e; run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 2
test ! -s "$R/gateway.counts"
cp "$TMP/release.good" "$FIX/release.json"; git add agents/tasks/release.json; git commit -qm 'restore release fixture'

echo STAGE=rollback-after-migration
R="$TMP/rollback-migration"; init_runtime "$R"
BDB=$(logical_db_fingerprint "$R/state/data/tasks/tasks.sqlite3")
set +e; TASK_AGENT_DEPLOY_FAULT=after-migration run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 1
test "$(taskctl_runtime_version "$R")" = 0.4.0
test "$(logical_db_fingerprint "$R/state/data/tasks/tasks.sqlite3")" = "$BDB"
test "$(cat "$R/gateway.state")" = active

echo STAGE=rollback
R="$TMP/rollback"; init_runtime "$R"
BDB=$(logical_db_fingerprint "$R/state/data/tasks/tasks.sqlite3")
set +e; TASK_AGENT_DEPLOY_FAULT=after-install run "$R" >/dev/null 2>&1; C=$?; set -e
test "$C" -eq 1
test "$(taskctl_runtime_version "$R")" = 0.4.0
cmp -s "$OLD_TASKCTL" "$R/bin/taskctl"
test "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$R/state/extensions/taskctl/package.json")" = 0.4.0
grep -qx old-agent "$R/workspace-tasks/AGENTS.md"
test "$(logical_db_fingerprint "$R/state/data/tasks/tasks.sqlite3")" = "$BDB"
test "$(cat "$R/gateway.state")" = active

echo STAGE=same-plugin-taskctl-upgrade
node - "$FIX/plugins/taskctl/package.json" "$FIX/plugins/taskctl/package-lock.json" "$FIX/plugins/taskctl/openclaw.plugin.json" <<'NODE'
const fs=require('fs');
for(const file of process.argv.slice(2)){
  const x=JSON.parse(fs.readFileSync(file,'utf8'));
  x.version='0.4.0';
  if(x.packages?.[''])x.packages[''].version='0.4.0';
  fs.writeFileSync(file,JSON.stringify(x,null,2)+'\n');
}
NODE
SAME_PKG="$TMP/same-plugin-pkg/package"
rm -rf "$TMP/same-plugin-pkg"
mkdir -p "$SAME_PKG"
cp "$FIX/plugins/taskctl/package.json" "$SAME_PKG/package.json"
tar -czf "$FIX/artifacts/openclaw-plugin-taskctl-0.4.0.tgz" -C "$TMP/same-plugin-pkg" package
SAME_SHA=$(sha256sum "$FIX/artifacts/openclaw-plugin-taskctl-0.4.0.tgz"|awk '{print $1}')
printf '%s\n' "$SAME_SHA" > "$FIX/artifacts/openclaw-plugin-taskctl-0.4.0.sha256"
node - "$FIX/release.json" "$SAME_SHA" <<'NODE'
const fs=require('fs'),file=process.argv[2],sha=process.argv[3],r=JSON.parse(fs.readFileSync(file,'utf8'));
r.plugin.version='0.4.0';
r.plugin.artifact='artifacts/openclaw-plugin-taskctl-0.4.0.tgz';
r.plugin.sha256=sha;
fs.writeFileSync(file,JSON.stringify(r,null,2)+'\n');
NODE
git add agents/tasks
git commit -qm 'same plugin taskctl fixture'
R="$TMP/same-plugin-taskctl"; init_runtime "$R"
preflight "$R" | grep -q 'start_is_target=0'
run "$R" >/dev/null
test "$(taskctl_runtime_version "$R")" = 0.4.1
test "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$R/state/extensions/taskctl/package.json")" = 0.4.0
preflight "$R" | grep -q 'start_is_target=1'

echo TASK_AGENT_RELEASE_DEPLOY_TEST_PASS
