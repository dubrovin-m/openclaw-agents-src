#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASKCTL=${1:-$ROOT/taskctl}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/tasks.sqlite3"
NOW='2026-09-16T08:00:00Z' # 11:00 Europe/Moscow
run(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$NOW" TASKCTL_PAYLOAD="$1" node "$TASKCTL" "$2" "$3"; }
contains(){ [[ "$1" == *"$2"* ]] || { echo "missing: $2" >&2; echo "$1" >&2; exit 1; }; }
expect_fail(){ local payload=$1 scope=$2 action=$3 needle=$4 output code; set +e; output=$(run "$payload" "$scope" "$action" 2>&1); code=$?; set -e; [ "$code" -ne 0 ] || { echo "expected failure: $scope $action" >&2; exit 1; }; contains "$output" "$needle"; }

TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" node "$TASKCTL" init >/dev/null
run '{"operation_key":"t1","title":"Исходный текст задачи","assignee":"Дубровин М."}' task create >/dev/null

# TA-REM-001/002/003/004/005 are model-time interpretation plus deterministic explicit time persistence.
a=$(run '{"operation_key":"r1","task_id":"T-1","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create)
contains "$a" '"id":"REM-1"'; contains "$a" '"task_id":"T-1"'; contains "$a" '"trigger_at":"2026-09-16T09:00:00.000Z"'; contains "$a" '"display_text":"Исходный текст задачи"'
a=$(run '{"operation_key":"r2","text":"Позвонить маме","trigger_date":"2026-09-17","trigger_time":"18:00"}' reminder create)
contains "$a" '"id":"REM-2"'; contains "$a" '"trigger_at":"2026-09-17T15:00:00.000Z"'

# TA-REM-006/007: past time and closed-task link fail without persistence.
expect_fail '{"operation_key":"past","text":"past","trigger_date":"2026-09-16","trigger_time":"10:00"}' reminder create REMINDER_TIME_PASSED
run '{"operation_key":"closed-task","title":"Closed","assignee":"Дубровин М."}' task create >/dev/null
run '{"operation_key":"closed-done","id":"T-2"}' task complete >/dev/null
expect_fail '{"operation_key":"closed-rem","task_id":"T-2","trigger_date":"2026-09-17","trigger_time":"12:00"}' reminder create INVALID_STATE

# TA-REM-008: title is live Task state, not copied Reminder text.
run '{"operation_key":"rename","id":"T-1","title":"Актуальный текст задачи"}' task update >/dev/null
a=$(run '{}' reminder list); contains "$a" '"display_text":"Актуальный текст задачи"'; contains "$a" '"text":null'

# TA-REM-011/012/013: list, reschedule, cancel; identity preserved.
a=$(run '{"operation_key":"move","id":"REM-2","trigger_date":"2026-09-18","trigger_time":"22:00"}' reminder reschedule)
contains "$a" '"id":"REM-2"'; contains "$a" '"trigger_at":"2026-09-18T19:00:00.000Z"'; contains "$a" '"changed":true'
a=$(run '{"operation_key":"cancel","id":"REM-2"}' reminder cancel); contains "$a" '"close_reason":"USER_CANCELLED"'
a=$(run '{}' reminder list); contains "$a" '"id":"REM-1"'; [[ "$a" != *'"id":"REM-2"'* ]]

# TA-REM-018: idempotent replay and conflicting key.
a=$(run '{"operation_key":"move","id":"REM-2","trigger_date":"2026-09-18","trigger_time":"22:00"}' reminder reschedule); contains "$a" '"idempotent_replay":true'
expect_fail '{"operation_key":"move","id":"REM-1","trigger_date":"2026-09-18","trigger_time":"22:00"}' reminder reschedule IDEMPOTENCY_KEY_REUSE

# Claim due REM-1. Pre-send render sees current title.
a=$(run '{"claim_token":"job:100","boundary":"2026-09-16T09:00:00.000Z"}' reminder-internal dispatch)
contains "$a" '"count":1'; contains "$a" '"message":"🔔 Напоминание: Актуальный текст задачи"'
a=$(run '{"claim_token":"job:100"}' reminder-internal render); contains "$a" '"count":1'

# TA-REM-009 and pre-send race: Task completion atomically closes claimed linked reminder;
# a second render for the same claim is empty, so outbound hook can suppress it.
a=$(run '{"operation_key":"done-t1","id":"T-1"}' task complete); contains "$a" '"closed_reminders":["REM-1"]'
a=$(run '{"claim_token":"job:100"}' reminder-internal render); contains "$a" '"count":0'; contains "$a" '"message":""'
a=$(run '{"claim_token":"job:100","delivered":true}' reminder-internal settle); contains "$a" '"count":0'

# TA-REM-010: cancellation closes every linked ACTIVE reminder atomically.
run '{"operation_key":"t3","title":"Cancel target","assignee":"Дубровин М."}' task create >/dev/null
run '{"operation_key":"r3a","task_id":"T-3","trigger_date":"2026-09-17","trigger_time":"09:00"}' reminder create >/dev/null
run '{"operation_key":"r3b","task_id":"T-3","trigger_date":"2026-09-17","trigger_time":"12:00"}' reminder create >/dev/null
a=$(run '{"operation_key":"cancel-t3","id":"T-3"}' task cancel); contains "$a" '"closed_reminders":["REM-3","REM-4"]'

# TA-REM-014/015/017/019: success closes, failure releases, later run can retry, batch renders independently.
run '{"operation_key":"standalone-a","text":"Первое","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
run '{"operation_key":"standalone-b","text":"Второе","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
a=$(run '{"claim_token":"job:200","boundary":"2026-09-16T09:00:00.000Z"}' reminder-internal dispatch)
contains "$a" '"count":2'; contains "$a" '🔔 Напоминание: Первое'; contains "$a" '🔔 Напоминание: Второе'
a=$(run '{"claim_token":"job:200","delivered":false}' reminder-internal settle); contains "$a" '"count":2'; contains "$a" '"delivered":false'
a=$(run '{"claim_token":"job:201","boundary":"2026-09-16T09:01:00.000Z"}' reminder-internal dispatch); contains "$a" '"count":2'
a=$(run '{"claim_token":"job:201","delivered":true}' reminder-internal settle); contains "$a" '"count":2'; contains "$a" '"delivered":true'
a=$(run '{"claim_token":"job:202","boundary":"2026-09-16T09:02:00.000Z"}' reminder-internal dispatch); contains "$a" '"count":0'

# TA-REM-016: stale claim becomes retryable after five-minute lease expiry.
run '{"operation_key":"stale","text":"Stale","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
run '{"claim_token":"job:300","boundary":"2026-09-16T09:03:00.000Z"}' reminder-internal dispatch >/dev/null
a=$(run '{"claim_token":"job:301","boundary":"2026-09-16T09:08:00.000Z"}' reminder-internal dispatch); contains "$a" '"count":1'; contains "$a" '"Stale"'

# In-flight user mutation fails closed rather than racing scheduler ownership.
expect_fail '{"operation_key":"stale-move","id":"REM-7","trigger_date":"2026-09-17","trigger_time":"12:00"}' reminder reschedule REMINDER_IN_FLIGHT
expect_fail '{"operation_key":"stale-cancel","id":"REM-7"}' reminder cancel REMINDER_IN_FLIGHT

# Store remains healthy.
a=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" node "$TASKCTL" health); contains "$a" '"schema_version":9'; contains "$a" '"reminders":7'
node - "$DB" <<'JS'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});
if(db.prepare('pragma integrity_check').get().integrity_check!=='ok')process.exit(1);
if(db.prepare('pragma foreign_key_check').all().length)process.exit(1);
db.close();
JS
# Native command dispatcher: no model/tool delivery dependency.
DDB="$TMP/dispatch.sqlite3"
DCONFIG="$TMP/openclaw.json"
DFAKE="$TMP/openclaw-fake"
DCAPTURE="$TMP/send-capture.jsonl"
cat >"$DCONFIG" <<'JSON'
{
  "channels": {
    "telegram": {
      "accounts": {
        "tasks": {
          "enabled": true,
          "dmPolicy": "allowlist",
          "allowFrom": ["test-owner"],
          "groupPolicy": "allowlist",
          "groupAllowFrom": ["test-owner"]
        }
      }
    }
  },
  "bindings": [
    {"agentId":"tasks","match":{"channel":"telegram","accountId":"tasks"}}
  ]
}
JSON
cat >"$DFAKE" <<'JS'
#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const args=process.argv.slice(2),value=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
if(args[0]!=='message'||args[1]!=='send')process.exit(64);
const mode=process.env.TASKCTL_TEST_SEND_MODE||'success';
if(mode==='task-close-race'){
  const taskId=process.env.TASKCTL_TEST_RACE_TASK,taskctl=process.env.TASKCTL_TEST_TASKCTL;
  if(!taskId||!taskctl)process.exit(65);
  const complete=spawnSync(process.execPath,[taskctl,'task','complete'],{encoding:'utf8',env:{...process.env,TASKCTL_PAYLOAD:JSON.stringify({operation_key:'send-race-complete',id:taskId})}});
  if(complete.status===0||!String(complete.stdout??'').includes('"code":"REMINDER_IN_FLIGHT"'))process.exit(66);
}
fs.appendFileSync(process.env.TASKCTL_TEST_SEND_CAPTURE,JSON.stringify({
  channel:value('--channel'),account:value('--account'),target:value('--target'),message:value('--message')
})+'\n');
if(mode==='failure'){process.stdout.write(JSON.stringify({ok:false,error:{type:'cli_error',message:'synthetic definite failure'}})+'\n');process.exit(1);}
if(mode==='unknown')process.exit(75);
process.stdout.write(JSON.stringify({
  action:'send',channel:'telegram',dryRun:false,handledBy:'plugin',messageId:'4242',
  payload:{ok:true,messageId:'4242',chatId:value('--target'),receipt:{}}
})+'\n');
JS
chmod 700 "$DFAKE"
drun(){
  local now=$1 payload=$2 scope=$3 action=$4
  TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DDB" TASKCTL_TEST_NOW="$now" TASKCTL_PAYLOAD="$payload" node "$TASKCTL" "$scope" "$action"
}
dsend(){
  local now=$1 mode=$2 race_task=${3:-}
  TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DDB" TASKCTL_TEST_NOW="$now" \
    TASKCTL_TEST_OPENCLAW_CONFIG="$DCONFIG" TASKCTL_TEST_OPENCLAW_BIN="$DFAKE" \
    TASKCTL_TEST_SEND_MODE="$mode" TASKCTL_TEST_SEND_CAPTURE="$DCAPTURE" \
    TASKCTL_TEST_TASKCTL="$TASKCTL" TASKCTL_TEST_RACE_TASK="$race_task" \
    node "$TASKCTL" reminder-internal dispatch-send
}
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DDB" node "$TASKCTL" init >/dev/null

# No due Reminder means no outbound invocation.
drun '2026-09-16T08:00:00Z' '{"operation_key":"future","text":"Позже","trigger_date":"2026-09-16","trigger_time":"13:00"}' reminder create >/dev/null
a=$(dsend '2026-09-16T09:00:00Z' success); contains "$a" '"count":0'; [ ! -e "$DCAPTURE" ]

# Standalone + Task-linked due Reminders are rendered deterministically using current Task title.
drun '2026-09-16T08:00:00Z' '{"operation_key":"dispatch-task","title":"Старое название","assignee":"Дубровин М."}' task create >/dev/null
drun '2026-09-16T08:00:00Z' '{"operation_key":"dispatch-linked","task_id":"T-1","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
drun '2026-09-16T08:00:00Z' '{"operation_key":"dispatch-standalone","text":"Отдельное","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
drun '2026-09-16T08:00:00Z' '{"operation_key":"dispatch-rename","id":"T-1","title":"Текущее название"}' task update >/dev/null
a=$(dsend '2026-09-16T09:00:00Z' success); contains "$a" '"count":2'; contains "$a" '"delivered":2'
capture=$(tail -n 1 "$DCAPTURE")
contains "$capture" '"channel":"telegram"'; contains "$capture" '"account":"tasks"'; contains "$capture" '"target":"test-owner"'
contains "$capture" '🔔 Напоминание: Текущее название\n\n🔔 Напоминание: Отдельное'
node - "$DDB" <<'JS'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const rows=db.prepare("select status,close_reason,claim_token from reminders where id in (2,3) order by id").all();
  if(rows.length!==2||rows.some(r=>r.status!=='CLOSED'||r.close_reason!=='DELIVERED'||r.claim_token!==null))process.exit(2);
}finally{db.close();}
JS

# A Task completed before dispatch cannot emit stale linked content.
drun '2026-09-16T08:00:00Z' '{"operation_key":"closed-before","title":"Не отправлять","assignee":"Дубровин М."}' task create >/dev/null
drun '2026-09-16T08:00:00Z' '{"operation_key":"closed-before-rem","task_id":"T-2","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
drun '2026-09-16T08:30:00Z' '{"operation_key":"closed-before-done","id":"T-2"}' task complete >/dev/null
before_lines=$(wc -l <"$DCAPTURE")
a=$(dsend '2026-09-16T09:00:00Z' success); contains "$a" '"count":0'
[ "$(wc -l <"$DCAPTURE")" -eq "$before_lines" ]

# Definite failure and unknown/crash are both conservative: claim stays leased, then expires and retries.
drun '2026-09-16T08:00:00Z' '{"operation_key":"retry-failure","text":"Повтор после ошибки","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
set +e
a=$(dsend '2026-09-16T09:00:00Z' failure 2>&1); rc=$?
set -e
[ "$rc" -ne 0 ]; contains "$a" 'REMINDER_DELIVERY_UNCONFIRMED'
node - "$DDB" <<'JS'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});
try{const r=db.prepare('select status,close_reason,claim_token,claim_expires_at from reminders where id=5').get();if(r.status!=='ACTIVE'||r.close_reason!==null||!r.claim_token||!r.claim_expires_at)process.exit(2);}finally{db.close();}
JS
a=$(dsend '2026-09-16T09:01:00Z' success); contains "$a" '"count":0'
a=$(dsend '2026-09-16T09:05:00Z' success); contains "$a" '"count":1'; contains "$a" '"delivered":1'

drun '2026-09-16T08:00:00Z' '{"operation_key":"retry-unknown","text":"Повтор после неизвестного исхода","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
set +e
a=$(dsend '2026-09-16T09:06:00Z' unknown 2>&1); rc=$?
set -e
[ "$rc" -ne 0 ]; contains "$a" 'REMINDER_DELIVERY_UNCONFIRMED'
a=$(dsend '2026-09-16T09:07:00Z' success); contains "$a" '"count":0'
a=$(dsend '2026-09-16T09:11:00Z' success); contains "$a" '"count":1'; contains "$a" '"delivered":1'

# Final send decision is serialized against Task closure. A concurrent completion
# after SEND_STARTED must roll back, delivery settles exactly, and retry then succeeds.
drun '2026-09-16T08:00:00Z' '{"operation_key":"send-race-task","title":"Гонка закрытия","assignee":"Дубровин М."}' task create >/dev/null
drun '2026-09-16T08:00:00Z' '{"operation_key":"send-race-rem","task_id":"T-3","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
a=$(dsend '2026-09-16T09:12:00Z' task-close-race T-3); contains "$a" '"count":1'; contains "$a" '"delivered":1'
a=$(drun '2026-09-16T09:12:00Z' '{"id":"T-3"}' task get); contains "$a" '"status":"OPEN"'
node - "$DDB" <<'JS'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});
try{const r=db.prepare('select status,close_reason,claim_token from reminders where task_id=3').get();if(!r||r.status!=='CLOSED'||r.close_reason!=='DELIVERED'||r.claim_token!==null)process.exit(2);}finally{db.close();}
JS
a=$(drun '2026-09-16T09:12:01Z' '{"operation_key":"send-race-complete-retry","id":"T-3"}' task complete); contains "$a" '"changed":true'

# An ambiguous/failed send can defer Task closure only for the bounded claim lease.
drun '2026-09-16T08:00:00Z' '{"operation_key":"lease-task","title":"Закрыть после lease","assignee":"Дубровин М."}' task create >/dev/null
drun '2026-09-16T08:00:00Z' '{"operation_key":"lease-rem","task_id":"T-4","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
set +e
a=$(dsend '2026-09-16T09:13:00Z' failure 2>&1); rc=$?
set -e
[ "$rc" -ne 0 ]; contains "$a" 'REMINDER_DELIVERY_UNCONFIRMED'
set +e
a=$(drun '2026-09-16T09:14:00Z' '{"operation_key":"lease-complete-too-soon","id":"T-4"}' task complete 2>&1); rc=$?
set -e
[ "$rc" -ne 0 ]; contains "$a" 'REMINDER_IN_FLIGHT'
a=$(drun '2026-09-16T09:18:00Z' '{"operation_key":"lease-complete-after-expiry","id":"T-4"}' task complete); contains "$a" '"changed":true'
node - "$DDB" <<'JS'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});
try{const r=db.prepare('select status,close_reason,claim_token from reminders where task_id=4').get();if(!r||r.status!=='CLOSED'||r.close_reason!=='TASK_COMPLETED'||r.claim_token!==null)process.exit(2);}finally{db.close();}
JS

# Owner route ambiguity fails closed before outbound send and leaves the claim retryable.
node - "$DCONFIG" <<'JS'
const fs=require('node:fs'),p=process.argv[2],c=JSON.parse(fs.readFileSync(p,'utf8'));c.channels.telegram.accounts.tasks.allowFrom.push('other-owner');fs.writeFileSync(p,JSON.stringify(c));
JS
drun '2026-09-16T08:00:00Z' '{"operation_key":"route-fail","text":"Маршрут","trigger_date":"2026-09-16","trigger_time":"12:00"}' reminder create >/dev/null
set +e
a=$(dsend '2026-09-16T09:12:00Z' success 2>&1); rc=$?
set -e
[ "$rc" -ne 0 ]; contains "$a" 'REMINDER_ROUTE_INVALID'

# Ordinary Task Agent policy has no dispatcher, exec, cron, or Gateway authority.
node - "$ROOT/config/tasks-tools.json" <<'JS'
const p=require(process.argv[2]),allow=new Set(p.allow||[]),deny=new Set(p.deny||[]);
if(allow.has('task_reminder_dispatch'))process.exit(2);
for(const x of ['exec','cron','gateway'])if(!deny.has(x))process.exit(3);
JS

# TA-REM activation migration gate: exercise the immutable schema-7 historical
# Reminder predecessor. Current deployment predecessor may already be schema 9.
REPO=$(cd "$ROOT/../.." && pwd)
CONTACTCTL="$REPO/shared/contacts/contactctl"
PRED=eb4d5b60ba0e17d9db8205885ed401d873e7687d
git -C "$REPO" cat-file -e "$PRED^{commit}"
PREDROOT="$TMP/predecessor-root"
mkdir -p "$PREDROOT"
git -C "$REPO" archive "$PRED" agents/tasks/taskctl shared/contacts/core.cjs shared/contacts/task-store.cjs | tar -x -C "$PREDROOT"
chmod 700 "$PREDROOT/agents/tasks/taskctl"
PDB="$TMP/predecessor.sqlite3"; PCDB="$TMP/predecessor-contacts.sqlite3"; PN='2026-09-16T08:00:00Z'
prun(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PDB" TASKCTL_CONTACTS_DB="$PCDB" TASKCTL_TEST_NOW="$PN" TASKCTL_PAYLOAD="$1" node "$PREDROOT/agents/tasks/taskctl" "$2" "$3"; }
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PDB" TASKCTL_CONTACTS_DB="$PCDB" TASKCTL_TEST_NOW="$PN" node "$PREDROOT/agents/tasks/taskctl" init >/dev/null
SELF=$(prun '{}' person list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).people.find(p=>p.display_name==="Дубровин М.").id))')
prun '{"operation_key":"mig-label","display_name":"Migration"}' label create >/dev/null
prun '{"operation_key":"mig-project","title":"Migration project"}' project create >/dev/null
prun '{"operation_key":"mig-task","title":"Preserve me","assignee":"Дубровин М.","due_date":"2026-09-20","labels":["L-1"],"project_id":"PRJ-1"}' task create >/dev/null
prun '{"operation_key":"mig-comment","task_id":"T-1","content":"Preserve comment"}' comment add >/dev/null
prun '{"operation_key":"mig-inbox","capture_key":"migration-inbox","content":"Preserve inbox"}' inbox add >/dev/null
prun "{\"operation_key\":\"mig-rec\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"DAYS\",\"interval\":2,\"start_date\":\"2026-09-18\"},\"title\":\"Preserve recurrence\",\"assignee_id\":\"$SELF\"}" recurrence create >/dev/null
BEFORE=$(node - "$PDB" "$PCDB" <<'JS'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true}),c=new DatabaseSync(process.argv[3],{readOnly:true});try{const count=t=>Number(d.prepare(`select count(*) n from ${t}`).get().n);const out={uv:Number(d.prepare('pragma user_version').get().user_version),tasks:count('tasks'),labels:count('labels'),projects:count('projects'),comments:count('task_comments'),inbox:count('inbox_items'),recurrences:count('recurrences'),people:Number(c.prepare('select count(*) n from people').get().n),aliases:Number(c.prepare('select count(*) n from person_aliases').get().n),task:d.prepare('select id,title,assignee_id,status,due_date,due_time,project_id from tasks order by id').all(),rec:d.prepare('select id,status,mode,title,assignee_id,due_time,target_project_id,rule_json,calendar_cursor_date from recurrences order by id').all()};process.stdout.write(JSON.stringify(out));}finally{d.close();c.close();}
JS
)
contains "$BEFORE" '"uv":7'
cp "$PDB" "$TMP/fault-predecessor.sqlite3"; cp "$PCDB" "$TMP/fault-predecessor-contacts.sqlite3"
# Production deployment owns the Contacts schema migration before Task validation.
CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$PCDB" "$CONTACTCTL" init >/dev/null
MIG=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PDB" TASKCTL_CONTACTS_DB="$PCDB" TASKCTL_TEST_NOW="$PN" node "$TASKCTL" health)
node - "$BEFORE" "$MIG" "$PDB" "$PCDB" <<'JS'
const {DatabaseSync}=require('node:sqlite'),before=JSON.parse(process.argv[2]),health=JSON.parse(process.argv[3]),d=new DatabaseSync(process.argv[4],{readOnly:true}),c=new DatabaseSync(process.argv[5],{readOnly:true});try{const count=t=>Number(d.prepare(`select count(*) n from ${t}`).get().n);if(health.schema_version!==9||health.implementation_version!=='0.4.13'||before.uv!==7)process.exit(2);if(count('tasks')!==before.tasks||count('labels')!==before.labels||count('projects')!==before.projects||count('task_comments')!==before.comments||count('inbox_items')!==before.inbox||count('recurrences')!==before.recurrences||count('reminders')!==0)process.exit(3);if(Number(c.prepare('select count(*) n from people').get().n)!==before.people||Number(c.prepare('select count(*) n from person_aliases').get().n)!==before.aliases)process.exit(4);if(JSON.stringify(d.prepare('select id,title,assignee_id,status,due_date,due_time,project_id from tasks order by id').all())!==JSON.stringify(before.task))process.exit(5);if(JSON.stringify(d.prepare('select id,status,mode,title,assignee_id,due_time,target_project_id,rule_json,calendar_cursor_date from recurrences order by id').all())!==JSON.stringify(before.rec))process.exit(6);if(d.prepare('pragma integrity_check').get().integrity_check!=='ok'||d.prepare('pragma foreign_key_check').all().length!==0||c.prepare('pragma integrity_check').get().integrity_check!=='ok'||c.prepare('pragma foreign_key_check').all().length!==0)process.exit(7);}finally{d.close();c.close();}
JS
CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$TMP/fault-predecessor-contacts.sqlite3" "$CONTACTCTL" init >/dev/null
set +e
FAULT=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TMP/fault-predecessor.sqlite3" TASKCTL_CONTACTS_DB="$TMP/fault-predecessor-contacts.sqlite3" TASKCTL_TEST_NOW="$PN" TASKCTL_TEST_REMINDER_MIGRATION_FAULT=after-reminder-ddl node "$TASKCTL" health 2>&1); FRC=$?
set -e
[ "$FRC" -ne 0 ]; contains "$FAULT" 'TEST_REMINDER_MIGRATION_FAULT'
node - "$TMP/fault-predecessor.sqlite3" <<'JS'
const {DatabaseSync}=require('node:sqlite'),d=new DatabaseSync(process.argv[2],{readOnly:true});try{if(Number(d.prepare('pragma user_version').get().user_version)!==7)process.exit(2);if(d.prepare("select 1 from sqlite_master where type='table' and name='reminders'").get())process.exit(3);if(d.prepare('pragma integrity_check').get().integrity_check!=='ok'||d.prepare('pragma foreign_key_check').all().length!==0)process.exit(4);}finally{d.close();}
JS

printf 'REMINDERS_V1_DETERMINISTIC_PASS\n'
