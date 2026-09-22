#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(git -C "$ROOT" rev-parse --show-toplevel)
RELEASE="$ROOT/release.json"
CONTACTS_RELEASE="$REPO_ROOT/shared/contacts/release.json"
TMP=$(mktemp -d /tmp/task-agent-important-date-deploy.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
fail(){ echo "$*" >&2; exit 2; }

eval "$(node - "$RELEASE" "$CONTACTS_RELEASE" <<'NODE'
const r=require(process.argv[2]),c=require(process.argv[3]),q=v=>`'${String(v).replace(/'/g,"'\\''")}'`;
if(r?.from?.sqlite_schemas?.[0]!==8||!r?.important_date_dispatcher||r?.shared_contacts?.predecessor_mode!=='exact'||r?.task_governance?.kind!=='private-bootstrap-v1'||!c?.from)process.exit(2);
const vals={PRED:r.from.source_revision,PRED_TASKCTL:r.from.taskctl_versions[0],PRED_SCHEMA:r.from.sqlite_schemas[0],PRED_PLUGIN:r.from.plugin_versions[0],TARGET_TASKCTL:r.generation.taskctl_version,TARGET_SCHEMA:r.generation.sqlite_schema,TARGET_PLUGIN:r.plugin.version,PRED_CONTACTS:c.from.implementation_version,PRED_CONTACTS_SCHEMA:c.from.sqlite_schema,PRED_CONTACTS_PLUGIN:c.from.plugin_version,TARGET_CONTACTS:c.implementation_version,TARGET_CONTACTS_SCHEMA:c.sqlite_schema,TOOLS_SHA:r.from.workspace_sha256["TOOLS.md"],GOV_BOOTSTRAP:r.task_governance.bootstrap_path,MATERIALIZER_KEY:r.calendar_materializer.declaration_key,MATERIALIZER_NAME:r.calendar_materializer.name,MATERIALIZER_CRON:r.calendar_materializer.cron,MATERIALIZER_TZ:r.calendar_materializer.timezone,MATERIALIZER_TIMEOUT:r.calendar_materializer.timeout_seconds,REMINDER_KEY:r.reminder_dispatcher.declaration_key,REMINDER_NAME:r.reminder_dispatcher.name,REMINDER_CRON:r.reminder_dispatcher.cron,REMINDER_TZ:r.reminder_dispatcher.timezone,REMINDER_SCRIPT:r.reminder_dispatcher.script,REMINDER_TOOL:r.reminder_dispatcher.tool,REMINDER_TIMEOUT:r.reminder_dispatcher.timeout_seconds,REMINDER_BUDGET:r.reminder_dispatcher.tool_budget,IMPORTANT_KEY:r.important_date_dispatcher.declaration_key,IMPORTANT_SCRIPT:r.important_date_dispatcher.script,IMPORTANT_TOOL:r.important_date_dispatcher.tool};
for(const [k,v] of Object.entries(vals))console.log(`${k}=${q(v)}`);
NODE
)" || fail "invalid release metadata"

OPENCLAW_BIN=$(command -v openclaw || true)
[ -x "$OPENCLAW_BIN" ] || OPENCLAW_BIN="$ROOT/plugins/taskctl/node_modules/.bin/openclaw"
[ -x "$OPENCLAW_BIN" ] || fail "OpenClaw unavailable"
OPENCLAW_ROOT=$(node - "$OPENCLAW_BIN" <<'NODE'
const fs=require('fs'),path=require('path');let p=fs.realpathSync(process.argv[2]),d=path.dirname(p);while(d!=='/'){const f=path.join(d,'package.json');if(fs.existsSync(f)){const j=JSON.parse(fs.readFileSync(f,'utf8'));if(j.name==='openclaw'){process.stdout.write(d);process.exit(0)}}d=path.dirname(d)}process.exit(2);
NODE
) || fail "OpenClaw package root unavailable"
export TASK_AGENT_TEST_OPENCLAW_ROOT="$OPENCLAW_ROOT"
export TASK_AGENT_TEST_RUNTIME_CONTRACT_ROOT="$REPO_ROOT"

PRED_SRC="$TMP/predecessor-source"
git clone -q --shared --no-checkout "$REPO_ROOT" "$PRED_SRC"
git -C "$PRED_SRC" checkout -q --detach "$PRED"
BASE="$TMP/predecessor"
PATH="$(dirname "$OPENCLAW_BIN"):$PATH" TASK_AGENT_TEST_PRODUCTION_WORKSPACE_LAYOUT=1 bash "$PRED_SRC/agents/tasks/install.sh" --test-root "$BASE" >/dev/null
mkdir -p "$BASE/state/backups/tools-md-migration"
git -C "$REPO_ROOT" show "$PRED:agents/tasks/workspace/TOOLS.md" > "$BASE/state/backups/tools-md-migration/tasks-$TOOLS_SHA.md"
chmod 600 "$BASE/state/backups/tools-md-migration/tasks-$TOOLS_SHA.md"

mkdir -p "$BASE/state/secrets"
printf '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n' > "$BASE/state/secrets/tasks.token"
chmod 600 "$BASE/state/secrets/tasks.token"
node - "$BASE/state/openclaw.json" "$BASE/state/secrets/tasks.token" <<'NODE'
const fs=require('fs'),p=process.argv[2],tokenFile=process.argv[3],c=JSON.parse(fs.readFileSync(p,'utf8'));
c.commands??={};c.commands.ownerAllowFrom=['telegram:424242'];
c.channels??={};c.channels.telegram??={};c.channels.telegram.enabled=true;c.channels.telegram.accounts??={};
c.channels.telegram.accounts.tasks={enabled:true,tokenFile,dmPolicy:'allowlist',allowFrom:['test-owner'],groupPolicy:'allowlist',groupAllowFrom:['test-owner']};
c.channels.telegram.accounts.default={...(c.channels.telegram.accounts.default??{}),enabled:true,dmPolicy:'pairing'};
c.bindings=(Array.isArray(c.bindings)?c.bindings:[]).filter(x=>!(x?.match?.channel==='telegram'&&['tasks','default'].includes(x?.match?.accountId)));
c.bindings.push({agentId:'tasks',match:{channel:'telegram',accountId:'tasks'}},{agentId:'main',match:{channel:'telegram',accountId:'default'}});
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n',{mode:0o600});
NODE
mkdir -p "$TMP/shims"
ln -s "$OPENCLAW_BIN" "$TMP/shims/openclaw-real"
cat > "$TMP/shims/openclaw" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = automations ]; then
  STATE=${OPENCLAW_STATE_DIR:?}; FILE="$STATE/automations-test.json"
  [ -f "$FILE" ] || printf '{"jobs":[]}\n' > "$FILE"
  case "${2:-}" in
    status)
      ROOT_STATE=$(dirname "$STATE")
      [ "$(cat "$ROOT_STATE/gateway.state" 2>/dev/null || true)" = active ] || exit 2
      echo '{"enabled":true}'; exit 0 ;;
    list) cat "$FILE"; exit 0 ;;
    add)
      SCRIPT_INPUT=""; args=("${@:3}")
      for ((i=0;i<${#args[@]};i++)); do
        if [ "${args[$i]}" = --script ] && [ "${args[$((i+1))]:-}" = - ]; then SCRIPT_INPUT=$(cat); fi
      done
      export SCRIPT_INPUT
      node - "$FILE" "${@:3}" <<'NODE'
const fs=require('fs'),p=process.argv[2],a=process.argv.slice(3),opt=n=>{const i=a.indexOf(n);return i>=0?a[i+1]:undefined};
const x=JSON.parse(fs.readFileSync(p,'utf8')),jobs=Array.isArray(x.jobs)?x.jobs:[],key=opt('--declaration-key');
if(!key||jobs.some(j=>j.declarationKey===key))process.exit(2);
let payload,delivery;
if(opt('--command-argv')){payload={kind:'command',argv:JSON.parse(opt('--command-argv')),timeoutSeconds:Number(opt('--timeout-seconds'))};delivery={mode:a.includes('--no-deliver')?'none':'announce'};}
else if(opt('--script')==='-'){payload={kind:'script',script:process.env.SCRIPT_INPUT??'',toolsAllow:String(opt('--tools')??'').split(/[ ,]+/).filter(Boolean),timeoutSeconds:Number(opt('--script-timeout-seconds')),toolBudget:Number(opt('--script-tool-budget'))};delivery={mode:a.includes('--announce')?'announce':'none',channel:opt('--channel'),to:opt('--to'),accountId:opt('--account'),...(a.includes('--best-effort-deliver')?{bestEffort:true}:{})};}
else process.exit(2);
const job={id:`job-${jobs.length+1}`,declarationKey:key,name:opt('--name'),enabled:true,agentId:opt('--agent'),schedule:{kind:'cron',expr:opt('--cron'),tz:opt('--tz'),staggerMs:a.includes('--exact')?0:undefined},sessionTarget:opt('--session')||'isolated',wakeMode:'now',payload,delivery};
jobs.push(job);fs.writeFileSync(p,JSON.stringify({jobs},null,2)+'\n');process.stdout.write(JSON.stringify({created:true,job})+'\n');
NODE
      exit 0 ;;
    rm|remove)
      node - "$FILE" "$3" <<'NODE'
const fs=require('fs'),p=process.argv[2],id=process.argv[3],x=JSON.parse(fs.readFileSync(p,'utf8')),jobs=x.jobs||[],next=jobs.filter(j=>j.id!==id);
if(next.length===jobs.length)process.exit(2);
fs.writeFileSync(p,JSON.stringify({jobs:next},null,2)+'\n');process.stdout.write(JSON.stringify({removed:true,id})+'\n');
NODE
      exit 0 ;;
  esac
  exit 2
fi
exec "$(dirname "$0")/openclaw-real" "$@"
SHIM
chmod 755 "$TMP/shims/openclaw"

cat > "$TMP/shims/systemctl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
R=${TASK_AGENT_TEST_ROOT:?}; [ "${1:-}" = --user ] && shift
case "${1:-}" in
  stop) echo inactive > "$R/gateway.state" ;;
  start) echo active > "$R/gateway.state" ;;
  is-active) [ "${2:-}" = --quiet ] && shift; [ "$(cat "$R/gateway.state" 2>/dev/null || true)" = active ] || exit 3 ;;
  *) exit 2 ;;
esac
SHIM
chmod 755 "$TMP/shims/systemctl"
export PATH="$TMP/shims:$ROOT/plugins/taskctl/node_modules/.bin:$(dirname "$(command -v node)"):/usr/bin:/bin"
oc(){ HOME="$1/home" OPENCLAW_HOME="$1/home" OPENCLAW_STATE_DIR="$1/state" OPENCLAW_CONFIG_PATH="$1/state/openclaw.json" openclaw "${@:2}"; }
node - "$BASE/state/automations-test.json" "$BASE/bin/taskctl" "$MATERIALIZER_KEY" "$MATERIALIZER_NAME" "$MATERIALIZER_CRON" "$MATERIALIZER_TZ" "$MATERIALIZER_TIMEOUT" "$REMINDER_KEY" "$REMINDER_NAME" "$REMINDER_CRON" "$REMINDER_TZ" "$REMINDER_SCRIPT" "$REMINDER_TOOL" "$REMINDER_TIMEOUT" "$REMINDER_BUDGET" <<'NODE'
const fs=require('fs'),p=process.argv[2],taskctl=process.argv[3];
const [mk,mn,mc,mt,mto,rk,rn,rc,rt,rs,rtool,rtimeout,rbudget]=process.argv.slice(4);
const jobs=[
{id:'recurrence-predecessor',declarationKey:mk,name:mn,enabled:true,agentId:'tasks',schedule:{kind:'cron',expr:mc,tz:mt,staggerMs:0},sessionTarget:'isolated',wakeMode:'now',payload:{kind:'command',argv:[taskctl,'recurrence','materialize'],timeoutSeconds:Number(mto)},delivery:{mode:'none'}},
{id:'reminder-predecessor',declarationKey:rk,name:rn,enabled:true,agentId:'tasks',schedule:{kind:'cron',expr:rc,tz:rt,staggerMs:0},sessionTarget:'isolated',wakeMode:'now',payload:{kind:'script',script:rs,toolsAllow:[rtool],timeoutSeconds:Number(rtimeout),toolBudget:Number(rbudget)},delivery:{mode:'announce',channel:'telegram',to:'test-owner',accountId:'tasks'}}
];
fs.writeFileSync(p,JSON.stringify({jobs},null,2)+'\n');
NODE
echo active > "$BASE/gateway.state"
oc "$BASE" plugins registry --refresh --json >/dev/null
node "$PRED_SRC/agents/tasks/production-control/plugin-registry-state.cjs" verify-target "$BASE/state/state/openclaw.sqlite" 2026.8.2 "$PRED_PLUGIN" "$PRED_CONTACTS" || fail "predecessor plugin registry is not exact"
oc "$BASE" config validate >/dev/null || fail "synthetic predecessor config invalid"

SELF_PERSON=$(node - "$BASE/state/data/contacts/contacts.sqlite3" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const p=db.prepare("select id from people where is_self=1 and status='ACTIVE' and merged_into is null").all();if(p.length!==1)process.exit(2);process.stdout.write('P-'+p[0].id);}finally{db.close();}
NODE
) || fail "predecessor self identity unavailable"
PERSONAL_RESULT=$(HOME="$BASE/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$BASE/state/data/tasks/tasks.sqlite3" TASKCTL_CONTACTS_DB="$BASE/state/data/contacts/contacts.sqlite3" TASKCTL_PAYLOAD='{"operation_key":"governance-personal-fixture","display_name":"Bootstrap Personal","emoji":"🏠"}' "$BASE/bin/taskctl" label create) || fail "unable to create predecessor personal Label fixture"
PERSONAL_LABEL=$(node -e 'const x=JSON.parse(process.argv[1]),id=x?.label?.id;if(!/^L-[1-9]\d*$/.test(id||""))process.exit(2);process.stdout.write(id)' "$PERSONAL_RESULT") || fail "invalid personal Label fixture"
BOOTSTRAP="$BASE/state/$GOV_BOOTSTRAP"
mkdir -p "$(dirname "$BOOTSTRAP")"
node - "$BOOTSTRAP" "$SELF_PERSON" "$PERSONAL_LABEL" <<'NODE'
const fs=require('fs'),out={format:'task-governance-bootstrap-v1',office_ceo_members:[process.argv[3]],personal_label_id:process.argv[4]};fs.writeFileSync(process.argv[2],JSON.stringify(out,null,2)+'\n',{mode:0o600});
NODE
chmod 600 "$BOOTSTRAP"

automation_count(){ node - "$1/state/automations-test.json" "$2" <<'NODE'
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),key=process.argv[3];process.stdout.write(String((x.jobs||[]).filter(j=>j.declarationKey===key).length));
NODE
}
contacts_state(){ node - "$1/state/data/contacts/contacts.sqlite3" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});
try{const table=n=>db.prepare("select count(*) n from sqlite_master where type='table' and name=?").get(n).n>0;
const out={uv:Number(db.prepare('pragma user_version').get().user_version),people:db.prepare('select id,display_name,organization,title,is_self,status,merged_into,created_at,updated_at from people order by id').all(),aliases:db.prepare('select person_id,alias,created_at from person_aliases order by person_id,alias').all(),important:table('important_dates')?Number(db.prepare('select count(*) n from important_dates').get().n):null,reminders:table('important_date_reminders')?Number(db.prepare('select count(*) n from important_date_reminders').get().n):null,groups:table('person_groups')?Number(db.prepare('select count(*) n from person_groups').get().n):null,group_members:table('person_group_members')?Number(db.prepare('select count(*) n from person_group_members').get().n):null,integrity:db.prepare('pragma integrity_check').get().integrity_check,fk:db.prepare('pragma foreign_key_check').all().length};process.stdout.write(JSON.stringify(out));}
finally{db.close();}
NODE
}
assert_predecessor(){
  local r=$1 th ch
  th=$(HOME="$r/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" TASKCTL_CONTACTS_DB="$r/state/data/contacts/contacts.sqlite3" "$r/bin/taskctl" health) || fail "predecessor taskctl unhealthy"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3]))process.exit(1)' "$th" "$PRED_TASKCTL" "$PRED_SCHEMA" || fail "predecessor Task generation drift"
  ch=$(HOME="$r/home" CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$r/state/data/contacts/contacts.sqlite3" CONTACTCTL_PAYLOAD='{}' "$r/bin/contactctl" health) || fail "predecessor Contacts unhealthy"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3]))process.exit(1)' "$ch" "$PRED_CONTACTS" "$PRED_CONTACTS_SCHEMA" || fail "predecessor Contacts drift"
  [ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$r/state/extensions/contacts/package.json")" = "$PRED_CONTACTS_PLUGIN" ] || fail "predecessor Contacts plugin drift"
  [ "$(automation_count "$r" "$MATERIALIZER_KEY")" = 1 ] || fail "predecessor materializer missing"
  [ "$(automation_count "$r" "$REMINDER_KEY")" = 1 ] || fail "predecessor Reminder dispatcher missing"
  [ "$(automation_count "$r" "$IMPORTANT_KEY")" = 0 ] || fail "Important Dates dispatcher unexpectedly present"
}
assert_target(){
  local r=$1 th ch
  th=$(HOME="$r/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" TASKCTL_CONTACTS_DB="$r/state/data/contacts/contacts.sqlite3" "$r/bin/taskctl" health) || fail "target taskctl unhealthy"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3]))process.exit(1)' "$th" "$TARGET_TASKCTL" "$TARGET_SCHEMA" || fail "target Task generation mismatch"
  ch=$(HOME="$r/home" CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$r/state/data/contacts/contacts.sqlite3" CONTACTCTL_PAYLOAD='{}' "$r/bin/contactctl" health) || fail "target Contacts unhealthy"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.implementation_version!==process.argv[2]||x.schema_version!==Number(process.argv[3])||x.integrity?.ok!==true)process.exit(1)' "$ch" "$TARGET_CONTACTS" "$TARGET_CONTACTS_SCHEMA" || fail "target Contacts generation mismatch"
  [ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$r/state/extensions/taskctl/package.json")" = "$TARGET_PLUGIN" ] || fail "target Task plugin mismatch"
  [ "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$r/state/extensions/contacts/package.json")" = "$TARGET_CONTACTS" ] || fail "target Contacts plugin mismatch"
  local gov; gov=$(HOME="$r/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$r/state/data/tasks/tasks.sqlite3" TASKCTL_CONTACTS_DB="$r/state/data/contacts/contacts.sqlite3" TASKCTL_PAYLOAD='{}' "$r/bin/taskctl" config validate) || fail "target governance bindings invalid"
  node -e 'const x=JSON.parse(process.argv[1]);if(x.office_ceo_group_id!=="PG-1"||x.personal_label_id!==process.argv[2])process.exit(1)' "$gov" "$PERSONAL_LABEL" || fail "target governance binding mismatch"
  node - "$r/state/data/contacts/contacts.sqlite3" "$SELF_PERSON" <<'NODE' || fail "target Office CEO membership mismatch"
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const g=db.prepare("select id from person_groups where display_name='Office CEO'").all();if(g.length!==1)process.exit(1);const m=db.prepare('select person_id from person_group_members where group_id=? order by person_id').all(g[0].id).map(x=>'P-'+x.person_id);if(JSON.stringify(m)!==JSON.stringify([process.argv[3]]))process.exit(2);}finally{db.close();}
NODE
  [ "$(automation_count "$r" "$MATERIALIZER_KEY")" = 1 ] || fail "Recurrence materializer changed"
  [ "$(automation_count "$r" "$REMINDER_KEY")" = 1 ] || fail "Task Reminder dispatcher changed"
  [ "$(automation_count "$r" "$IMPORTANT_KEY")" = 1 ] || fail "Important Dates dispatcher missing"
}
assert_important_shape(){
  node - "$1/state/automations-test.json" "$IMPORTANT_KEY" "$IMPORTANT_SCRIPT" "$IMPORTANT_TOOL" <<'NODE' || fail "Important Dates dispatcher shape mismatch"
const fs=require('fs'),x=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),j=(x.jobs||[]).find(v=>v.declarationKey===process.argv[3]);
if(!j||j.agentId!=='main'||j.payload?.kind!=='script'||j.payload.script!==process.argv[4]||JSON.stringify(j.payload.toolsAllow)!==JSON.stringify([process.argv[5]])||j.delivery?.mode!=='announce'||j.delivery?.channel!=='telegram'||j.delivery?.accountId!=='default'||j.delivery?.to!=='424242'||(j.delivery?.bestEffort!==undefined&&j.delivery?.bestEffort!==false))process.exit(1);
NODE
}
clone_runtime(){
  cp -a "$1" "$2"
  node - "$2/state/openclaw.json" "$1" "$2" <<'NODE'
const fs=require('fs'),p=process.argv[2],from=process.argv[3],to=process.argv[4],rewrite=v=>typeof v==='string'&&v.startsWith(from)?to+v.slice(from.length):Array.isArray(v)?v.map(rewrite):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rewrite(x)])):v;
fs.writeFileSync(p,JSON.stringify(rewrite(JSON.parse(fs.readFileSync(p,'utf8'))),null,2)+'\n',{mode:0o600});
NODE
  node - "$2/state/automations-test.json" "$1" "$2" <<'NODE'
const fs=require('fs'),p=process.argv[2],from=process.argv[3],to=process.argv[4],rewrite=v=>typeof v==='string'&&v.startsWith(from)?to+v.slice(from.length):Array.isArray(v)?v.map(rewrite):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,z])=>[k,rewrite(z)])):v;
fs.writeFileSync(p,JSON.stringify(rewrite(JSON.parse(fs.readFileSync(p,'utf8'))),null,2)+'\n');
NODE
}

assert_predecessor "$BASE"
CONTACTS_BEFORE=$(contacts_state "$BASE")

MISSING="$TMP/missing-governance-bootstrap"; clone_runtime "$BASE" "$MISSING"; echo active > "$MISSING/gateway.state"
rm -f "$MISSING/state/$GOV_BOOTSTRAP"
set +e
HOME="$MISSING/home" bash "$ROOT/deploy.sh" --test-root "$MISSING" --preflight >/dev/null 2>&1
MISSING_CODE=$?
set -e
[ "$MISSING_CODE" -eq 2 ] || fail "missing governance bootstrap did not block preflight"
assert_predecessor "$MISSING"

R="$TMP/success"; clone_runtime "$BASE" "$R"; echo active > "$R/gateway.state"
HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --preflight | grep -q 'TASK_AGENT_DEPLOY_PREFLIGHT_PASS' || fail "Important Dates preflight failed"
HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --apply >/dev/null || fail "Important Dates deploy failed"
assert_target "$R"; assert_important_shape "$R"
node - "$CONTACTS_BEFORE" "$(contacts_state "$R")" "$TARGET_CONTACTS_SCHEMA" <<'NODE' || fail "Contacts migration changed predecessor identity data beyond approved Person Group activation"
const a=JSON.parse(process.argv[2]),b=JSON.parse(process.argv[3]),schema=Number(process.argv[4]);if(JSON.stringify(a.people)!==JSON.stringify(b.people)||JSON.stringify(a.aliases)!==JSON.stringify(b.aliases)||b.uv!==schema||b.important!==0||b.reminders!==0||b.groups!==1||b.group_members!==1||b.integrity!=='ok'||b.fk!==0)process.exit(1);
NODE
RECOVERY=$(find "$R/backups" -maxdepth 1 -type d -name 'task-agent-stage-*' -print -quit)
[ -n "$RECOVERY" ] || fail "recovery set missing"
node - "$RECOVERY/contacts-state.json" "$PRED_CONTACTS_SCHEMA" <<'NODE' || fail "Contacts recovery snapshot does not preserve declared predecessor"
const x=require(process.argv[2]),schema=Number(process.argv[3]);if(x.format!=='shared-contacts-recovery-v2'||x.db_present!==true||x.schema_version!==schema)process.exit(1);
NODE
test -f "$RECOVERY/important-date-dispatcher.before.json" || fail "Important Dates dispatcher recovery snapshot missing"
bash "$ROOT/recover.sh" --test-root "$R" --apply --confirm-outage --from "$RECOVERY" >/dev/null || fail "manual Important Dates recovery failed"
assert_predecessor "$R"
node - "$CONTACTS_BEFORE" "$(contacts_state "$R")" <<'NODE' || fail "manual recovery changed Contacts predecessor data"
const a=JSON.parse(process.argv[2]),b=JSON.parse(process.argv[3]);if(JSON.stringify(a)!==JSON.stringify(b))process.exit(1);
NODE

rm -rf "$R/backups"/task-agent-stage-* "$R/deliverables"
set +e
TASK_AGENT_DEPLOY_FAULT=after-governance-activation HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --apply >/dev/null 2>&1
CODE=$?
set -e
[ "$CODE" -eq 1 ] || fail "post-governance activation fault did not roll back"
assert_predecessor "$R"
node - "$CONTACTS_BEFORE" "$(contacts_state "$R")" <<'NODE' || fail "post-governance rollback changed Contacts predecessor data"
const a=JSON.parse(process.argv[2]),b=JSON.parse(process.argv[3]);if(JSON.stringify(a)!==JSON.stringify(b))process.exit(1);
NODE

rm -rf "$R/backups"/task-agent-stage-* "$R/deliverables"
set +e
CONTACTCTL_TEST_MIGRATION_FAULT=after-person-group-ddl HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --apply >/dev/null 2>&1
CODE=$?
set -e
[ "$CODE" -eq 2 ] || fail "faulted Contacts Person Group migration did not fail closed before mutation"
assert_predecessor "$R"

rm -rf "$R/backups"/task-agent-stage-* "$R/deliverables"
set +e
TASK_AGENT_DEPLOY_FAULT=after-important-date-dispatcher HOME="$R/home" bash "$ROOT/deploy.sh" --test-root "$R" --apply >/dev/null 2>&1
CODE=$?
set -e
[ "$CODE" -eq 1 ] || fail "post-dispatcher fault did not roll back"
assert_predecessor "$R"
node - "$CONTACTS_BEFORE" "$(contacts_state "$R")" <<'NODE' || fail "post-dispatcher rollback changed Contacts predecessor data"
const a=JSON.parse(process.argv[2]),b=JSON.parse(process.argv[3]);if(JSON.stringify(a)!==JSON.stringify(b))process.exit(1);
NODE

echo TASK_AGENT_IMPORTANT_DATE_DEPLOY_QUALIFICATION_PASS
