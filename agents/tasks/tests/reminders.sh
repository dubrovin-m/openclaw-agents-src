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
a=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" node "$TASKCTL" health); contains "$a" '"schema_version":8'; contains "$a" '"reminders":7'
node - "$DB" <<'JS'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});
if(db.prepare('pragma integrity_check').get().integrity_check!=='ok')process.exit(1);
if(db.prepare('pragma foreign_key_check').all().length)process.exit(1);
db.close();
JS
# TA-REM activation migration gate: exercise the exact declared schema-7 predecessor,
# preserve representative Task/Recurrence/Inbox state, and prove migration rollback.
REPO=$(cd "$ROOT/../.." && pwd)
PRED=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.from.source_revision)' "$ROOT/release.json")
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
MIG=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PDB" TASKCTL_CONTACTS_DB="$PCDB" TASKCTL_TEST_NOW="$PN" node "$TASKCTL" health)
node - "$BEFORE" "$MIG" "$PDB" "$PCDB" <<'JS'
const {DatabaseSync}=require('node:sqlite'),before=JSON.parse(process.argv[2]),health=JSON.parse(process.argv[3]),d=new DatabaseSync(process.argv[4],{readOnly:true}),c=new DatabaseSync(process.argv[5],{readOnly:true});try{const count=t=>Number(d.prepare(`select count(*) n from ${t}`).get().n);if(health.schema_version!==8||health.implementation_version!=='0.4.11'||before.uv!==7)process.exit(2);if(count('tasks')!==before.tasks||count('labels')!==before.labels||count('projects')!==before.projects||count('task_comments')!==before.comments||count('inbox_items')!==before.inbox||count('recurrences')!==before.recurrences||count('reminders')!==0)process.exit(3);if(Number(c.prepare('select count(*) n from people').get().n)!==before.people||Number(c.prepare('select count(*) n from person_aliases').get().n)!==before.aliases)process.exit(4);if(JSON.stringify(d.prepare('select id,title,assignee_id,status,due_date,due_time,project_id from tasks order by id').all())!==JSON.stringify(before.task))process.exit(5);if(JSON.stringify(d.prepare('select id,status,mode,title,assignee_id,due_time,target_project_id,rule_json,calendar_cursor_date from recurrences order by id').all())!==JSON.stringify(before.rec))process.exit(6);if(d.prepare('pragma integrity_check').get().integrity_check!=='ok'||d.prepare('pragma foreign_key_check').all().length!==0||c.prepare('pragma integrity_check').get().integrity_check!=='ok'||c.prepare('pragma foreign_key_check').all().length!==0)process.exit(7);}finally{d.close();c.close();}
JS
set +e
FAULT=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TMP/fault-predecessor.sqlite3" TASKCTL_CONTACTS_DB="$TMP/fault-predecessor-contacts.sqlite3" TASKCTL_TEST_NOW="$PN" TASKCTL_TEST_REMINDER_MIGRATION_FAULT=after-reminder-ddl node "$TASKCTL" health 2>&1); FRC=$?
set -e
[ "$FRC" -ne 0 ]; contains "$FAULT" 'TEST_REMINDER_MIGRATION_FAULT'
node - "$TMP/fault-predecessor.sqlite3" <<'JS'
const {DatabaseSync}=require('node:sqlite'),d=new DatabaseSync(process.argv[2],{readOnly:true});try{if(Number(d.prepare('pragma user_version').get().user_version)!==7)process.exit(2);if(d.prepare("select 1 from sqlite_master where type='table' and name='reminders'").get())process.exit(3);if(d.prepare('pragma integrity_check').get().integrity_check!=='ok'||d.prepare('pragma foreign_key_check').all().length!==0)process.exit(4);}finally{d.close();}
JS

printf 'REMINDERS_V1_DETERMINISTIC_PASS\n'
