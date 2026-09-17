#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel)
RELEASE="$ROOT/release.json"
TMP=$(mktemp -d /tmp/task-agent-reminder-deploy.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
fail(){ echo "$*" >&2; exit 2; }

read_release(){
  node - "$RELEASE" <<'NODE'
const r=require(process.argv[2]);const q=v=>`'${String(v).replace(/'/g,"'\\''")}'`;
if(r?.shared_contacts?.predecessor_mode!=='exact'||!r?.reminder_dispatcher)process.exit(2);
console.log(`PRED=${q(r.from.source_revision)}`);
console.log(`PRED_TASKCTL=${q(r.from.taskctl_versions[0])}`);
console.log(`PRED_SCHEMA=${q(r.from.sqlite_schemas[0])}`);
console.log(`PRED_PLUGIN=${q(r.from.plugin_versions[0])}`);
console.log(`TARGET_TASKCTL=${q(r.generation.taskctl_version)}`);
console.log(`TARGET_SCHEMA=${q(r.generation.sqlite_schema)}`);
console.log(`TARGET_PLUGIN=${q(r.plugin.version)}`);
console.log(`CONTACTS_VERSION=${q(r.shared_contacts.implementation_version)}`);
console.log(`MATERIALIZER_KEY=${q(r.calendar_materializer.declaration_key)}`);
console.log(`MATERIALIZER_NAME=${q(r.calendar_materializer.name)}`);
console.log(`MATERIALIZER_CRON=${q(r.calendar_materializer.cron)}`);
console.log(`MATERIALIZER_TZ=${q(r.calendar_materializer.timezone)}`);
console.log(`MATERIALIZER_TIMEOUT=${q(r.calendar_materializer.timeout_seconds)}`);
console.log(`REMINDER_KEY=${q(r.reminder_dispatcher.declaration_key)}`);
console.log(`REMINDER_NAME=${q(r.reminder_dispatcher.name)}`);
console.log(`REMINDER_CRON=${q(r.reminder_dispatcher.cron)}`);
console.log(`REMINDER_TZ=${q(r.reminder_dispatcher.timezone)}`);
console.log(`REMINDER_SCRIPT=${q(r.reminder_dispatcher.script)}`);
console.log(`REMINDER_TOOL=${q(r.reminder_dispatcher.tool)}`);
console.log(`REMINDER_TIMEOUT=${q(r.reminder_dispatcher.timeout_seconds)}`);
console.log(`REMINDER_BUDGET=${q(r.reminder_dispatcher.tool_budget)}`);
NODE
}
eval "$(read_release)" || fail "Reminder release metadata invalid"
[ "$PRED_SCHEMA" = 7 ] || fail "Reminder deploy qualification requires schema-7 predecessor"
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

PRED_SRC="$TMP/predecessor-source"; mkdir -p "$PRED_SRC"
git -C "$REPO_ROOT" archive "$PRED" | tar -x -C "$PRED_SRC"
BASE="$TMP/predecessor"
TASK_AGENT_TEST_PRODUCTION_WORKSPACE_LAYOUT=1 bash "$PRED_SRC/agents/tasks/install.sh" --test-root "$BASE" >/dev/null

# Production predecessor already contains the retired TOOLS.md archive required by
# the current deployment fingerprint, although it is absent from active workspace.
TOOLS_SHA=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.from.workspace_sha256["TOOLS.md"])' "$RELEASE")
mkdir -p "$BASE/state/backups/tools-md-migration"
git -C "$REPO_ROOT" show "$PRED:agents/tasks/workspace/TOOLS.md" > "$BASE/state/backups/tools-md-migration/tasks-$TOOLS_SHA.md"
chmod 600 "$BASE/state/backups/tools-md-migration/tasks-$TOOLS_SHA.md"

# Add a synthetic owner-only Telegram route. No production credential or recipient
# is copied into the fixture; deploy derives the destination from this isolated config.
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
      SCRIPT_INPUT=""; if printf '%s\n' "${@:3}" | grep -qx -- '--script'; then :; fi
      args=("${@:3}"); for ((i=0;i<${#args[@]};i++)); do if [ "${args[$i]}" = --script ] && [ "${args[$((i+1))]:-}" = - ]; then SCRIPT_INPUT=$(cat); fi; done
      export SCRIPT_INPUT
      node - "$FILE" "${@:3}" <<'NODE'
const fs=require('fs'),p=process.argv[2],a=process.argv.slice(3),opt=n=>{const i=a.indexOf(n);return i>=0?a[i+1]:undefined};
const x=JSON.parse(fs.readFileSync(p,'utf8')),jobs=Array.isArray(x.jobs)?x.jobs:[],key=opt('--declaration-key');if(!key||jobs.some(j=>j.declarationKey===key))process.exit(2);
let payload,delivery;
if(opt('--command-argv')){payload={kind:'command',argv:JSON.parse(opt('--command-argv')),timeoutSeconds:Number(opt('--timeout-seconds'))};delivery={mode:a.includes('--no-deliver')?'none':'announce'};}
else if(opt('--script')==='-'){payload={kind:'script',script:process.env.SCRIPT_INPUT??'',toolsAllow:String(opt('--tools')??'').split(/[ ,]+/).filter(Boolean),timeoutSeconds:Number(opt('--script-timeout-seconds')),toolBudget:Number(opt('--script-tool-budget'))};delivery={mode:a.includes('--announce')?'announce':'none',channel:opt('--channel'),to:opt('--to'),accountId:opt('--account'),bestEffort:a.includes('--best-effort-deliver')};}
else process.exit(2);
const job={id:`job-${jobs.length+1}`,declarationKey:key,name:opt('--name'),enabled:true,agentId:opt('--agent'),schedule:{kind:'cron',expr:opt('--cron'),tz:opt('--tz'),staggerMs:a.includes('--exact')?0:undefined},sessionTarget:opt('--session')||'isolated',wakeMode:'now',payload,delivery};
jobs.push(job);fs.writeFileSync(p,JSON.stringify({jobs},null,2)+'\n');process.stdout.write(JSON.stringify({created:true,job})+'\n');
NODE
      exit 0 ;;
    rm|remove)
      node - "$FILE" "$3" <<'NODE'
const fs=require('fs'),p=process.argv[2],id=process.argv[3],x=JSON.parse(fs.readFileSync(p,'utf8')),jobs=x.jobs||[],next=jobs.filter(j=>j.id!==id);if(next.length===jobs.length)process.exit(2);fs.writeFileSync(p,JSON.stringify({jobs:next},null,2)+'\n');process.stdout.write(JSON.stringify({removed:true,id})+'\n');
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

oc(){ HOME="$1/home" OPENCLAW_HOME="$1/home" OPENCLAW_STATE_DIR="$1/state" OPENCLAW_CONFIG_PATH="$1/state/openclaw.json" openclaw "${@:2}"; }
node - "$BASE/state/automations-test.json" "$BASE/bin/taskctl" "$MATERIALIZER_KEY" "$MATERIALIZER_NAME" "$MATERIALIZER_CRON" "$MATERIALIZER_TZ" "$MATERIALIZER_TIMEOUT" <<'NODE'
const fs=require('fs'),p=process.argv[2],taskctl=process.argv[3],key=process.argv[4],name=process.argv[5],expr=process.argv[6],tz=process.argv[7],timeout=Number(process.argv[8]);const job={id:'recurrence-predecessor',declarationKey:key,name,enabled:true,agentId:'tasks',schedule:{kind:'cron',expr,tz,staggerMs:0},sessionTarget:'isolated',wakeMode:'now',payload:{kind:'command',argv:[taskctl,'recurrence','materialize'],timeoutSeconds:timeout},delivery:{mode:'none'}};fs.writeFileSync(p,JSON.stringify({jobs:[job]},null,2)+'\n');
NODE
echo active > "$BASE/gateway.state"

# Refresh only the disposable provider registry and prove it represents the exact
# active Contacts predecessor before testing the Reminder release.
oc "$BASE" plugins registry --refresh --json >/dev/null
node "$PRED_SRC/agents/tasks/production-control/plugin-registry-state.cjs" verify-target "$BASE/state/state/openclaw.sqlite" 2026.8.2 "$PRED_PLUGIN" "$CONTACTS_VERSION" || fail "predecessor plugin registry is not exact"
oc "$BASE" config validate >/dev/null || fail "synthetic predecessor config invalid"

runtime_tools_sha(){ node - "$1/state/openclaw.json" <<'NODE'
const fs=require('fs'),crypto=require('crypto'),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),v=c?.agents?.entries?.tasks?.tools,stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';process.stdout.write(crypto.createHash('sha256').update(stable(v)).digest('hex'));
NODE
}
contacts_fingerprint(){ node - "$1/state/data/contacts/contacts.sqlite3" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const x={uv:Number(db.prepare('pragma user_version').get().user_version),people:db.prepare('select * from people order by id').all(),aliases:db.prepare('select * from person_aliases order by person_id,alias').all(),integrity:db.prepare('pragma integrity_check').get().integrity_check,fk:db.prepare('pragma foreign_key_check').all()};process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex'));}finally{db.close();}
NODE
}
automation_count(){ node - "$1/state/automations-test.json" "$2" <<'NODE'
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),key=process.argv[3];process.stdout.write(String((x.jobs||[]).filter(j=>j.declarationKey===key).length));
NODE
}
assert_predecessor(){
  local r=$1 h; h=$(HOME="$r/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" TASKCTL_CONTACTS_DB="$r/state/data/contacts/contacts.sqlite3" "$r/bin/taskctl" health) || fail "predecessor taskctl unhealthy"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3]))process.exit(1)' "$h" "$PRED_TASKCTL" "$PRED_SCHEMA" || fail "predecessor generation drift"
  [ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$r/state/extensions/taskctl/package.json")" = "$PRED_PLUGIN" ] || fail "predecessor plugin drift"
  [ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$r/state/extensions/contacts/package.json")" = "$CONTACTS_VERSION" ] || fail "Contacts plugin drift"
  [ "$(runtime_tools_sha "$r")" = "$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.from.tools_sha256)' "$RELEASE")" ] || fail "predecessor tool policy drift"
  [ "$(automation_count "$r" "$MATERIALIZER_KEY")" = 1 ] || fail "Recurrence materializer missing"
  [ "$(automation_count "$r" "$REMINDER_KEY")" = 0 ] || fail "Reminder dispatcher unexpectedly present"
}
assert_target(){
  local r=$1 h; h=$(HOME="$r/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" TASKCTL_CONTACTS_DB="$r/state/data/contacts/contacts.sqlite3" "$r/bin/taskctl" health) || fail "target taskctl unhealthy"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3]))process.exit(1)' "$h" "$TARGET_TASKCTL" "$TARGET_SCHEMA" || fail "target generation mismatch"
  [ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$r/state/extensions/taskctl/package.json")" = "$TARGET_PLUGIN" ] || fail "target plugin mismatch"
  [ "$(automation_count "$r" "$MATERIALIZER_KEY")" = 1 ] || fail "Recurrence materializer changed"
  [ "$(automation_count "$r" "$REMINDER_KEY")" = 1 ] || fail "Reminder dispatcher missing"
  node - "$r/state/automations-test.json" "$REMINDER_KEY" "$REMINDER_SCRIPT" "$REMINDER_TOOL" <<'NODE' || fail "Reminder dispatcher shape mismatch"
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),j=(x.jobs||[]).find(v=>v.declarationKey===process.argv[3]);if(!j||j.payload?.kind!=='script'||j.payload.script!==process.argv[4]||JSON.stringify(j.payload.toolsAllow)!==JSON.stringify([process.argv[5]])||j.delivery?.mode!=='announce'||j.delivery?.channel!=='telegram'||j.delivery?.accountId!=='tasks'||j.delivery?.to!=='test-owner'||j.delivery?.bestEffort!==false)process.exit(1);
NODE
}
clone_runtime(){ cp -a "$1" "$2"; node - "$2/state/openclaw.json" "$1" "$2" <<'NODE'
const fs=require('fs'),p=process.argv[2],from=process.argv[3],to=process.argv[4],rewrite=v=>typeof v==='string'&&v.startsWith(from)?to+v.slice(from.length):Array.isArray(v)?v.map(rewrite):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rewrite(x)])):v;c=rewrite(JSON.parse(fs.readFileSync(p,'utf8')));fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n',{mode:0o600});
NODE
node - "$2/state/automations-test.json" "$1" "$2" <<'NODE'
const fs=require('fs'),p=process.argv[2],from=process.argv[3],to=process.argv[4],x=JSON.parse(fs.readFileSync(p,'utf8')),rewrite=v=>typeof v==='string'&&v.startsWith(from)?to+v.slice(from.length):Array.isArray(v)?v.map(rewrite):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,z])=>[k,rewrite(z)])):v;fs.writeFileSync(p,JSON.stringify(rewrite(x),null,2)+'\n');
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
test -f "$RECOVERY/reminder-dispatcher.before.json" || fail "Reminder dispatcher recovery snapshot missing"
node - "$RECOVERY/reminder-dispatcher.before.json" "$REMINDER_KEY" <<'NODE' || fail "Reminder recovery snapshot invalid"
const x=require(process.argv[2]);if(x.format!=='task-agent-reminder-dispatcher-recovery-v1'||x.declaration_key!==process.argv[3]||!Array.isArray(x.jobs)||x.jobs.length!==0)process.exit(1);
NODE
bash "$ROOT/recover.sh" --test-root "$R" --apply --confirm-outage --from "$RECOVERY" >/dev/null || fail "manual Reminder recovery failed"
assert_predecessor "$R"
[ "$(contacts_fingerprint "$R")" = "$CONTACTS_BEFORE" ] || fail "Reminder recovery changed Contacts domain state"

# A post-dispatcher preparation fault must remove the newly created Automation and
# restore exact schema-7/plugin/workspace/config predecessor automatically.
rm -rf "$R/backups"/task-agent-stage-* "$R/deliverables"
set +e
TASK_AGENT_DEPLOY_FAULT=after-reminder-dispatcher HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --apply >/dev/null 2>&1
CODE=$?
set -e
[ "$CODE" -eq 1 ] || fail "faulted Reminder deploy did not roll back"
assert_predecessor "$R"
[ "$(contacts_fingerprint "$R")" = "$CONTACTS_BEFORE" ] || fail "automatic rollback changed Contacts domain state"

echo TASK_AGENT_REMINDER_DEPLOY_QUALIFICATION_PASS
