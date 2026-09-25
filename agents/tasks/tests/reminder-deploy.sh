#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel)
RELEASE="$ROOT/release.json"
TMP=$(mktemp -d /tmp/task-agent-reminder-deploy.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
fail(){ echo "$*" >&2; exit 2; }

eval "$(node - "$RELEASE" <<'NODE'
const r=require(process.argv[2]),m=r.reminder_dispatcher,q=v=>`'${String(v).replace(/'/g,"'\\''")}'`;
if(r?.shared_contacts?.predecessor_mode!=='exact'||m?.kind!=='openclaw-command-automation-v1'||m?.predecessor_mode!=='exact-disabled-script-0.4.26')process.exit(2);
for(const [k,v] of Object.entries({
  PRED:r.from.source_revision,PRED_TASKCTL:r.from.taskctl_versions[0],PRED_SCHEMA:r.from.sqlite_schemas[0],PRED_PLUGIN:r.from.plugin_versions[0],
  TARGET_TASKCTL:r.generation.taskctl_version,TARGET_SCHEMA:r.generation.sqlite_schema,TARGET_PLUGIN:r.plugin.version,
  CONTACTS_VERSION:r.shared_contacts.implementation_version,MATERIALIZER_KEY:r.calendar_materializer.declaration_key,
  REMINDER_KEY:m.declaration_key,REMINDER_NAME:m.name,REMINDER_CRON:m.cron,REMINDER_TZ:m.timezone,
  REMINDER_TIMEOUT:m.timeout_seconds,REMINDER_SUFFIX:JSON.stringify(m.command_argv_suffix)
}))console.log(`${k}=${q(v)}`);
NODE
)" || fail "Reminder release metadata invalid"
[ "$PRED_SCHEMA" = 9 ] || fail "Reminder predecessor must be schema 9"
[ "$PRED_PLUGIN" = "$TARGET_PLUGIN" ] || fail "Reminder simplification must not require a plugin release"
git -C "$REPO_ROOT" cat-file -e "$PRED^{commit}" || fail "Declared predecessor unavailable"

OPENCLAW_BIN=$(command -v openclaw || true)
[ -x "$OPENCLAW_BIN" ] || OPENCLAW_BIN="$ROOT/plugins/taskctl/node_modules/.bin/openclaw"
[ -x "$OPENCLAW_BIN" ] || fail "OpenClaw executable unavailable"
OPENCLAW_ROOT=$(node - "$OPENCLAW_BIN" <<'NODE'
const fs=require('fs'),path=require('path');let p=fs.realpathSync(process.argv[2]),d=path.dirname(p);while(d!=='/'){const f=path.join(d,'package.json');if(fs.existsSync(f)){const j=JSON.parse(fs.readFileSync(f,'utf8'));if(j.name==='openclaw'){process.stdout.write(d);process.exit(0)}}d=path.dirname(d)}process.exit(2);
NODE
) || fail "OpenClaw package root unavailable"
export TASK_AGENT_TEST_OPENCLAW_ROOT="$OPENCLAW_ROOT"
export TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT="$REPO_ROOT"

PRED_SRC="$TMP/predecessor-source"
git clone -q --no-hardlinks "$REPO_ROOT" "$PRED_SRC"
git -C "$PRED_SRC" checkout -q --detach "$PRED"
BASE="$TMP/predecessor"
PATH="$(dirname "$OPENCLAW_BIN"):$PATH" TASK_AGENT_TEST_PRODUCTION_WORKSPACE_LAYOUT=1 bash "$PRED_SRC/agents/tasks/install.sh" --test-root "$BASE" >/dev/null

mkdir -p "$BASE/state/secrets"
printf '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n' > "$BASE/state/secrets/tasks.token"
chmod 600 "$BASE/state/secrets/tasks.token"
node - "$BASE/state/openclaw.json" "$BASE/state/secrets/tasks.token" <<'NODE'
const fs=require('fs'),p=process.argv[2],tokenFile=process.argv[3],c=JSON.parse(fs.readFileSync(p,'utf8'));
c.channels??={};c.channels.telegram??={};c.channels.telegram.accounts??={};
c.channels.telegram.accounts.tasks={enabled:true,tokenFile,dmPolicy:'allowlist',allowFrom:['test-owner'],groupPolicy:'allowlist',groupAllowFrom:['test-owner']};
c.bindings=(Array.isArray(c.bindings)?c.bindings:[]).filter(x=>!(x?.match?.channel==='telegram'&&x?.match?.accountId==='tasks'));
c.bindings.push({agentId:'tasks',match:{channel:'telegram',accountId:'tasks'}});
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n',{mode:0o600});
NODE

mkdir -p "$TMP/shims"
ln -s "$OPENCLAW_BIN" "$TMP/shims/openclaw-real"
cat > "$TMP/shims/openclaw" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = automations ]; then
  STATE=${OPENCLAW_STATE_DIR:?}; FILE="$STATE/automations-test.json"; [ -f "$FILE" ] || printf '{"jobs":[]}\n' > "$FILE"
  case "${2:-}" in
    status)
      ROOT_STATE=$(dirname "$STATE"); [ "$(cat "$ROOT_STATE/gateway.state" 2>/dev/null || true)" = active ] || exit 2; echo '{"enabled":true}'; exit 0 ;;
    list) cat "$FILE"; exit 0 ;;
    add)
      SCRIPT_INPUT=""; args=("${@:3}"); for ((i=0;i<${#args[@]};i++)); do if [ "${args[$i]}" = --script ] && [ "${args[$((i+1))]:-}" = - ]; then SCRIPT_INPUT=$(cat); fi; done
      export SCRIPT_INPUT
      node - "$FILE" "${@:3}" <<'NODE'
const fs=require('fs'),p=process.argv[2],a=process.argv.slice(3),opt=n=>{const i=a.indexOf(n);return i>=0?a[i+1]:undefined};
const x=JSON.parse(fs.readFileSync(p,'utf8')),jobs=Array.isArray(x.jobs)?x.jobs:[],key=opt('--declaration-key');if(!key||jobs.some(j=>j.declarationKey===key))process.exit(2);
let payload,delivery,policy=null;
if(opt('--command-argv')){payload={kind:'command',argv:JSON.parse(opt('--command-argv')),timeoutSeconds:Number(opt('--timeout-seconds'))};delivery={mode:a.includes('--no-deliver')?'none':'announce'};}
else if(opt('--script')==='-'){payload={kind:'script',script:process.env.SCRIPT_INPUT??'',toolsAllow:String(opt('--tools')??'').split(/[ ,]+/).filter(Boolean),timeoutSeconds:Number(opt('--script-timeout-seconds')),toolBudget:Number(opt('--script-tool-budget'))};delivery={mode:a.includes('--announce')?'announce':'none',channel:opt('--channel'),to:opt('--to'),accountId:opt('--account')};policy={version:1,mode:'trusted'};}
else process.exit(2);
const job={id:`job-${jobs.length+1}`,declarationKey:key,name:opt('--name'),enabled:!a.includes('--disabled'),agentId:opt('--agent'),schedule:{kind:'cron',expr:opt('--cron'),tz:opt('--tz'),staggerMs:a.includes('--exact')?0:undefined},sessionTarget:opt('--session')||'isolated',wakeMode:'now',payload,delivery,scheduledToolPolicy:policy};
jobs.push(job);fs.writeFileSync(p,JSON.stringify({jobs},null,2)+'\n');process.stdout.write(JSON.stringify({created:true,job})+'\n');
NODE
      exit 0 ;;
    edit)
      ID=$3; shift 3; SCRIPT_INPUT=""; args=("$@"); for ((i=0;i<${#args[@]};i++)); do if [ "${args[$i]}" = --script ] && [ "${args[$((i+1))]:-}" = - ]; then SCRIPT_INPUT=$(cat); fi; done
      export SCRIPT_INPUT
      node - "$FILE" "$ID" "${args[@]}" <<'NODE'
const fs=require('fs'),p=process.argv[2],id=process.argv[3],a=process.argv.slice(4),opt=n=>{const i=a.indexOf(n);return i>=0?a[i+1]:undefined};
const x=JSON.parse(fs.readFileSync(p,'utf8')),j=(x.jobs||[]).find(v=>v.id===id);if(!j)process.exit(2);
if(a.includes('--disable'))j.enabled=false;if(a.includes('--enable'))j.enabled=true;
if(opt('--command-argv')){j.payload={kind:'command',argv:JSON.parse(opt('--command-argv')),timeoutSeconds:Number(opt('--timeout-seconds'))};j.scheduledToolPolicy=null;}
if(opt('--script')==='-'){j.payload={kind:'script',script:process.env.SCRIPT_INPUT??'',toolsAllow:String(opt('--tools')??'').split(/[ ,]+/).filter(Boolean),timeoutSeconds:Number(opt('--script-timeout-seconds')),toolBudget:Number(opt('--script-tool-budget'))};j.scheduledToolPolicy={version:1,mode:'trusted'};}
if(a.includes('--no-deliver'))j.delivery={mode:'none'};
if(a.includes('--announce'))j.delivery={mode:'announce',channel:opt('--channel'),to:opt('--to'),accountId:opt('--account')};
fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');process.stdout.write(JSON.stringify({ok:true,job:j})+'\n');
NODE
      exit 0 ;;
    rm|remove)
      node - "$FILE" "$3" <<'NODE'
const fs=require('fs'),p=process.argv[2],id=process.argv[3],x=JSON.parse(fs.readFileSync(p,'utf8')),jobs=x.jobs||[],next=jobs.filter(j=>j.id!==id);if(next.length===jobs.length)process.exit(2);fs.writeFileSync(p,JSON.stringify({jobs:next},null,2)+'\n');process.stdout.write(JSON.stringify({ok:true,id})+'\n');
NODE
      exit 0 ;;
  esac
  exit 2
fi
exec "$(dirname "$0")/openclaw-real" "$@"
SH
chmod 755 "$TMP/shims/openclaw"
cat > "$TMP/shims/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
R=${TASK_AGENT_TEST_ROOT:?}; [ "${1:-}" = --user ] && shift
case "${1:-}" in
  stop) echo inactive > "$R/gateway.state" ;;
  start) echo active > "$R/gateway.state" ;;
  is-active) [ "${2:-}" = --quiet ] && shift; [ "$(cat "$R/gateway.state" 2>/dev/null || true)" = active ] || exit 3 ;;
  *) exit 2 ;;
esac
SH
chmod 755 "$TMP/shims/systemctl"
export PATH="$TMP/shims:$ROOT/plugins/taskctl/node_modules/.bin:$(dirname "$(command -v node)"):/usr/bin:/bin"

LEGACY_SCRIPT='const dispatch = await task_reminder_dispatch({});
json(dispatch.count > 0 ? { notify: dispatch.message } : {});'
node - "$BASE/state/automations-test.json" "$BASE/bin/taskctl" "$MATERIALIZER_KEY" "$REMINDER_KEY" "$REMINDER_NAME" "$REMINDER_CRON" "$REMINDER_TZ" "$LEGACY_SCRIPT" <<'NODE'
const fs=require('fs'),p=process.argv[2],taskctl=process.argv[3],matKey=process.argv[4],key=process.argv[5],name=process.argv[6],expr=process.argv[7],tz=process.argv[8],script=process.argv[9];
const jobs=[
 {id:'recurrence-predecessor',declarationKey:matKey,name:'Task Recurrence Calendar Materializer',enabled:true,agentId:'tasks',schedule:{kind:'cron',expr:'0 * * * *',tz:'Europe/Moscow',staggerMs:0},sessionTarget:'isolated',wakeMode:'now',payload:{kind:'command',argv:[taskctl,'recurrence','materialize'],timeoutSeconds:30},delivery:{mode:'none'}},
 {id:'reminder-predecessor',declarationKey:key,name,enabled:false,agentId:'tasks',schedule:{kind:'cron',expr,tz,staggerMs:0},sessionTarget:'isolated',wakeMode:'now',payload:{kind:'script',script,toolsAllow:['task_reminder_dispatch'],timeoutSeconds:30,toolBudget:1},delivery:{mode:'announce',channel:'telegram',to:'test-owner',accountId:'tasks'},scheduledToolPolicy:{version:1,mode:'trusted'},state:{consecutiveErrors:5,lastStatus:'error'}}
];
fs.writeFileSync(p,JSON.stringify({jobs},null,2)+'\n');
NODE
echo active > "$BASE/gateway.state"

oc(){ HOME="$1/home" OPENCLAW_HOME="$1/home" OPENCLAW_STATE_DIR="$1/state" OPENCLAW_CONFIG_PATH="$1/state/openclaw.json" openclaw "${@:2}"; }
oc "$BASE" plugins registry --refresh --json >/dev/null
OPENCLAW_VERSION=$(node "$REPO_ROOT/shared/runtime-contract/runtime-contract.mjs" openclaw-version "$REPO_ROOT/runtime-contract.json")
node "$PRED_SRC/agents/tasks/production-control/plugin-registry-state.cjs" verify-target "$BASE/state/state/openclaw.sqlite" "$OPENCLAW_VERSION" "$PRED_PLUGIN" "$CONTACTS_VERSION" >/dev/null || fail "predecessor plugin registry is not exact"
oc "$BASE" config validate >/dev/null || fail "synthetic predecessor config invalid"

stable_tools_sha(){ node - "$1" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';process.stdout.write(crypto.createHash('sha256').update(stable(x)).digest('hex'));
NODE
}
runtime_tools_sha(){ node - "$1/state/openclaw.json" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),v=c?.agents?.entries?.tasks?.tools,stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';process.stdout.write(crypto.createHash('sha256').update(stable(v)).digest('hex'));
NODE
}
contacts_fingerprint(){ node - "$1/state/data/contacts/contacts.sqlite3" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const x={uv:Number(db.prepare('pragma user_version').get().user_version),people:db.prepare('select * from people order by id').all(),aliases:db.prepare('select * from person_aliases order by person_id,alias').all(),integrity:db.prepare('pragma integrity_check').get().integrity_check,fk:db.prepare('pragma foreign_key_check').all()};process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex'));}finally{db.close();}
NODE
}
clone_runtime(){ cp -a "$1" "$2"; node - "$2/state/openclaw.json" "$1" "$2" <<'NODE'
const fs=require('fs'),p=process.argv[2],from=process.argv[3],to=process.argv[4],rewrite=v=>typeof v==='string'&&v.startsWith(from)?to+v.slice(from.length):Array.isArray(v)?v.map(rewrite):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rewrite(x)])):v,c=rewrite(JSON.parse(fs.readFileSync(p,'utf8')));fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n',{mode:0o600});
NODE
node - "$2/state/automations-test.json" "$1" "$2" <<'NODE'
const fs=require('fs'),p=process.argv[2],from=process.argv[3],to=process.argv[4],x=JSON.parse(fs.readFileSync(p,'utf8')),rewrite=v=>typeof v==='string'&&v.startsWith(from)?to+v.slice(from.length):Array.isArray(v)?v.map(rewrite):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,z])=>[k,rewrite(z)])):v;fs.writeFileSync(p,JSON.stringify(rewrite(x),null,2)+'\n');
NODE
}
assert_predecessor(){
  local r=$1 h; h=$(HOME="$r/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" TASKCTL_CONTACTS_DB="$r/state/data/contacts/contacts.sqlite3" "$r/bin/taskctl" health) || fail "predecessor taskctl unhealthy"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3]))process.exit(1)' "$h" "$PRED_TASKCTL" "$PRED_SCHEMA" || fail "predecessor generation drift"
  [ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$r/state/extensions/taskctl/package.json")" = "$PRED_PLUGIN" ] || fail "predecessor plugin drift"
  [ "$(runtime_tools_sha "$r")" = "$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.from.tools_sha256)' "$RELEASE")" ] || fail "predecessor tool policy drift"
  node - "$r/state/automations-test.json" "$REMINDER_KEY" "$LEGACY_SCRIPT" <<'NODE' || fail "Reminder predecessor shape mismatch"
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),j=(x.jobs||[]).find(v=>v.declarationKey===process.argv[3]);if(!j||j.id!=='reminder-predecessor'||j.enabled!==false||j.payload?.kind!=='script'||j.payload.script!==process.argv[4]||JSON.stringify(j.payload.toolsAllow)!==JSON.stringify(['task_reminder_dispatch'])||j.payload.timeoutSeconds!==30||j.payload.toolBudget!==1||j.delivery?.mode!=='announce'||j.delivery?.channel!=='telegram'||j.delivery?.accountId!=='tasks'||j.delivery?.to!=='test-owner'||j.scheduledToolPolicy?.version!==1||j.scheduledToolPolicy?.mode!=='trusted')process.exit(1);
NODE
}
assert_target(){
  local r=$1 h expected; h=$(HOME="$r/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" TASKCTL_CONTACTS_DB="$r/state/data/contacts/contacts.sqlite3" "$r/bin/taskctl" health) || fail "target taskctl unhealthy"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3]))process.exit(1)' "$h" "$TARGET_TASKCTL" "$TARGET_SCHEMA" || fail "target generation mismatch"
  [ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$r/state/extensions/taskctl/package.json")" = "$TARGET_PLUGIN" ] || fail "target plugin mismatch"
  expected=$(stable_tools_sha "$ROOT/config/tasks-tools.json"); [ "$(runtime_tools_sha "$r")" = "$expected" ] || fail "target tool policy mismatch"
  node - "$r/state/automations-test.json" "$REMINDER_KEY" "$r/bin/taskctl" "$REMINDER_SUFFIX" "$REMINDER_TIMEOUT" <<'NODE' || fail "Reminder target shape mismatch"
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),j=(x.jobs||[]).find(v=>v.declarationKey===process.argv[3]),argv=[process.argv[4],...JSON.parse(process.argv[5])],timeout=Number(process.argv[6]);if(!j||j.id!=='reminder-predecessor'||typeof j.enabled!=='boolean'||j.payload?.kind!=='command'||JSON.stringify(j.payload.argv)!==JSON.stringify(argv)||j.payload.timeoutSeconds!==timeout||j.payload.toolsAllow!==undefined||j.delivery?.mode!=='none'||j.scheduledToolPolicy!=null)process.exit(1);
NODE
  node - "$r/state/openclaw.json" <<'NODE' || fail "ordinary Task surface still exposes Reminder scheduler authority"
const fs=require('fs'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),p=c?.agents?.entries?.tasks?.tools;if(!p||p.allow?.includes('task_reminder_dispatch'))process.exit(1);for(const x of ['exec','cron','gateway'])if(!p.deny?.includes(x))process.exit(1);
NODE
}

assert_predecessor "$BASE"
CONTACTS_BEFORE=$(contacts_fingerprint "$BASE")
R="$TMP/success"; clone_runtime "$BASE" "$R"; echo active > "$R/gateway.state"
HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --preflight | grep -q 'TASK_AGENT_DEPLOY_PREFLIGHT_PASS' || fail "Reminder preflight failed"
HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --apply >/dev/null || fail "Reminder deploy failed"
assert_target "$R"
[ "$(contacts_fingerprint "$R")" = "$CONTACTS_BEFORE" ] || fail "Reminder deploy mutated Contacts domain state"

RECOVERY=$(find "$R/backups" -maxdepth 1 -type d -name 'task-agent-stage-*' -print -quit); [ -n "$RECOVERY" ] || fail "recovery set missing"
node - "$RECOVERY/reminder-dispatcher.before.json" "$REMINDER_KEY" <<'NODE' || fail "Reminder recovery snapshot invalid"
const x=require(process.argv[2]);if(x.format!=='task-agent-reminder-dispatcher-recovery-v2'||x.declaration_key!==process.argv[3]||!Array.isArray(x.jobs)||x.jobs.length!==1||x.jobs[0]?.id!=='reminder-predecessor'||x.jobs[0]?.enabled!==false)process.exit(1);
NODE

# Enabled is operational state, not release-definition identity.
node - "$R/state/automations-test.json" "$REMINDER_KEY" <<'NODE'
const fs=require('fs'),p=process.argv[2],key=process.argv[3],x=JSON.parse(fs.readFileSync(p,'utf8')),j=(x.jobs||[]).find(v=>v.declarationKey===key);if(!j)process.exit(2);j.enabled=true;fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
NODE
HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --preflight | grep -q 'start_is_target=1' || fail "enabled target command job was misclassified as drift"
node - "$R/state/automations-test.json" "$REMINDER_KEY" <<'NODE'
const fs=require('fs'),p=process.argv[2],key=process.argv[3],x=JSON.parse(fs.readFileSync(p,'utf8')),j=(x.jobs||[]).find(v=>v.declarationKey===key);j.enabled=false;fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
NODE

bash "$ROOT/recover.sh" --test-root "$R" --apply --confirm-outage --from "$RECOVERY" >/dev/null || fail "manual Reminder recovery failed"
assert_predecessor "$R"
[ "$(contacts_fingerprint "$R")" = "$CONTACTS_BEFORE" ] || fail "Reminder recovery changed Contacts domain state"

# Same declaration key with anything except the exact disabled predecessor must stop.
node - "$R/state/automations-test.json" "$REMINDER_KEY" <<'NODE'
const fs=require('fs'),p=process.argv[2],key=process.argv[3],x=JSON.parse(fs.readFileSync(p,'utf8')),j=(x.jobs||[]).find(v=>v.declarationKey===key);j.enabled=true;fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
NODE
set +e
HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --preflight >/dev/null 2>&1
DRIFT_CODE=$?
set -e
[ "$DRIFT_CODE" -ne 0 ] || fail "non-exact Reminder predecessor passed preflight"
node - "$R/state/automations-test.json" "$REMINDER_KEY" <<'NODE'
const fs=require('fs'),p=process.argv[2],key=process.argv[3],x=JSON.parse(fs.readFileSync(p,'utf8')),j=(x.jobs||[]).find(v=>v.declarationKey===key);j.enabled=false;fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
NODE

rm -rf "$R/backups"/task-agent-stage-* "$R/deliverables"
set +e
TASK_AGENT_DEPLOY_FAULT=after-reminder-dispatcher HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --apply >/dev/null 2>&1
CODE=$?
set -e
[ "$CODE" -eq 1 ] || fail "faulted Reminder deploy did not roll back"
assert_predecessor "$R"
[ "$(contacts_fingerprint "$R")" = "$CONTACTS_BEFORE" ] || fail "automatic rollback changed Contacts domain state"

echo TASK_AGENT_REMINDER_DEPLOY_QUALIFICATION_PASS
