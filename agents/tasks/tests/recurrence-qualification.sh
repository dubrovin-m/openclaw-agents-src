#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASKCTL=${1:-$ROOT/taskctl}
TMP=$(mktemp -d /tmp/task-agent-recurrence-qualification.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
DB="$TMP/tasks.sqlite3"
run(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$1" TASKCTL_PAYLOAD="$2" "$TASKCTL" "$3" "$4"; }
reset_db(){ rm -f "$DB" "$DB-wal" "$DB-shm"; TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$1" "$TASKCTL" init >/dev/null; SELF=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD='{}' "$TASKCTL" person list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).people.find(p=>p.display_name==="Дубровин М.").id))'); }

# Ordinary Task shape remains unchanged; provenance appears only on generated Tasks.
reset_db 2026-09-01T07:00:00Z
ORD=$(run 2026-09-01T07:00:00Z "{\"operation_key\":\"ordinary\",\"title\":\"Ordinary\",\"assignee_id\":\"$SELF\"}" task create)
node -e 'const t=JSON.parse(process.argv[1]).task;if(Object.hasOwn(t,"recurrence"))process.exit(1)' "$ORD"

# DAYS catch-up across technical downtime: every missed active slot, exactly once.
D=$(run 2026-09-01T07:00:00Z "{\"operation_key\":\"days\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"DAYS\",\"interval\":3,\"start_date\":\"2026-09-01\"},\"title\":\"D\",\"assignee_id\":\"$SELF\"}" recurrence create)
DR=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).recurrence.id)' "$D")
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-10T08:00:00Z "$TASKCTL" recurrence materialize >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-10T09:00:00Z "$TASKCTL" recurrence materialize >/dev/null
node - "$DB" "$DR" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),n=Number(process.argv[3].slice(2)),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const d=db.prepare('select occurrence_date from recurrence_occurrences where recurrence_id=? order by occurrence_date').all(n).map(x=>x.occurrence_date);if(JSON.stringify(d)!==JSON.stringify(['2026-09-01','2026-09-04','2026-09-07','2026-09-10']))process.exit(1);}finally{db.close();}
NODE

# WEEKLY selected weekdays with N-week interval.
W=$(run 2026-09-01T07:00:00Z "{\"operation_key\":\"weeks\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"WEEKS\",\"interval\":2,\"weekdays\":[2,4],\"start_date\":\"2026-09-01\"},\"title\":\"W\",\"assignee_id\":\"$SELF\"}" recurrence create)
WR=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).recurrence.id)' "$W")
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-17T08:00:00Z "$TASKCTL" recurrence materialize >/dev/null
node - "$DB" "$WR" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),n=Number(process.argv[3].slice(2)),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const d=db.prepare('select occurrence_date from recurrence_occurrences where recurrence_id=? order by occurrence_date').all(n).map(x=>x.occurrence_date);if(JSON.stringify(d)!==JSON.stringify(['2026-09-01','2026-09-03','2026-09-15','2026-09-17']))process.exit(1);}finally{db.close();}
NODE

# MONTHLY day 1..28 and YEARLY fixed month/day.
M=$(run 2026-09-01T07:00:00Z "{\"operation_key\":\"months\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"MONTHS\",\"interval\":2,\"day\":5,\"start_date\":\"2026-09-05\"},\"title\":\"M\",\"assignee_id\":\"$SELF\"}" recurrence create)
MR=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).recurrence.id)' "$M")
Y=$(run 2026-09-01T07:00:00Z "{\"operation_key\":\"year\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"YEARLY\",\"month\":9,\"day\":20,\"start_date\":\"2026-09-20\"},\"title\":\"Y\",\"assignee_id\":\"$SELF\"}" recurrence create)
YR=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).recurrence.id)' "$Y")
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2027-09-20T08:00:00Z "$TASKCTL" recurrence materialize >/dev/null
node - "$DB" "$MR" "$YR" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const get=r=>db.prepare('select occurrence_date from recurrence_occurrences where recurrence_id=? order by occurrence_date').all(Number(r.slice(2))).map(x=>x.occurrence_date);if(JSON.stringify(get(process.argv[3]))!==JSON.stringify(['2026-09-05','2026-11-05','2027-01-05','2027-03-05','2027-05-05','2027-07-05','2027-09-05']))process.exit(1);if(JSON.stringify(get(process.argv[4]))!==JSON.stringify(['2026-09-20','2027-09-20']))process.exit(1);}finally{db.close();}
NODE
set +e
run 2026-09-01T07:00:00Z "{\"operation_key\":\"bad-month\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"MONTHS\",\"interval\":1,\"day\":29,\"start_date\":\"2026-09-29\"},\"title\":\"bad\",\"assignee_id\":\"$SELF\"}" recurrence create >/dev/null
[ $? -ne 0 ] || exit 1
set -e

# AFTER_COMPLETION is atomic under a deterministic mid-transaction fault.
reset_db 2026-09-01T07:00:00Z
A=$(run 2026-09-01T07:00:00Z "{\"operation_key\":\"after\",\"mode\":\"AFTER_COMPLETION\",\"rule\":{\"interval\":1,\"unit\":\"DAYS\"},\"title\":\"A\",\"assignee_id\":\"$SELF\",\"first_due_date\":\"2026-09-01\"}" recurrence create)
AT=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).first_occurrence.task_id)' "$A")
set +e
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_TEST_RECURRENCE_FAULT=after-complete-before-successor TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-02T08:00:00Z TASKCTL_PAYLOAD="{\"operation_key\":\"fault-complete\",\"id\":\"$AT\"}" "$TASKCTL" task complete >/dev/null
[ $? -ne 0 ] || exit 1
set -e
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD="{\"id\":\"$AT\"}" "$TASKCTL" task get | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(JSON.parse(s).task.status!=="OPEN")process.exit(1)})'
node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{if(db.prepare('select count(*) n from recurrence_occurrences').get().n!==1)process.exit(1);}finally{db.close();}
NODE
run 2026-09-02T08:00:00Z "{\"operation_key\":\"complete-ok\",\"id\":\"$AT\"}" task complete | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.task.status!=="DONE"||x.successor?.due_date!=="2026-09-03")process.exit(1)})'

# Project target is future-template-only; closed Projects cannot become a target; historical Tasks stay untouched.
reset_db 2026-09-01T07:00:00Z
PA=$(run 2026-09-01T07:00:00Z '{"operation_key":"pa","title":"A"}' project create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).project.id))')
PB=$(run 2026-09-01T07:00:00Z '{"operation_key":"pb","title":"B"}' project create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).project.id))')
PC=$(run 2026-09-01T07:00:00Z '{"operation_key":"pc","title":"C"}' project create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).project.id))')
run 2026-09-01T07:00:00Z "{\"operation_key\":\"pc-close\",\"id\":\"$PC\"}" project complete >/dev/null
set +e
run 2026-09-01T07:00:00Z "{\"operation_key\":\"bad-target\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"DAYS\",\"interval\":1,\"start_date\":\"2026-09-01\"},\"title\":\"bad\",\"assignee_id\":\"$SELF\",\"target_project_id\":\"$PC\"}" recurrence create >/dev/null
[ $? -ne 0 ] || exit 1
set -e
R=$(run 2026-09-01T07:00:00Z "{\"operation_key\":\"target-r\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"DAYS\",\"interval\":1,\"start_date\":\"2026-09-01\"},\"title\":\"target\",\"assignee_id\":\"$SELF\",\"target_project_id\":\"$PA\"}" recurrence create)
RID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).recurrence.id)' "$R")
FIRST=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).first_occurrence.task_id)' "$R")
run 2026-09-01T08:00:00Z "{\"operation_key\":\"move-target\",\"id\":\"$RID\",\"target_project_id\":\"$PB\"}" recurrence update >/dev/null
run 2026-09-01T09:00:00Z "{\"operation_key\":\"close-a\",\"id\":\"$PA\"}" project complete >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-02T08:00:00Z "$TASKCTL" recurrence materialize >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD="{\"id\":\"$FIRST\"}" "$TASKCTL" task get | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(JSON.parse(s).task.project_id!==process.argv[1])process.exit(1)})' "$PA"
node - "$DB" "$RID" "$PB" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const x=db.prepare('select t.project_id from recurrence_occurrences ro join tasks t on t.id=ro.task_id where ro.recurrence_id=? order by ro.id desc limit 1').get(Number(process.argv[3].slice(2)));if(`PRJ-${x.project_id}`!==process.argv[4])process.exit(1);}finally{db.close();}
NODE
run 2026-09-02T09:00:00Z "{\"operation_key\":\"cancel-calendar-task\",\"id\":\"T-2\"}" task cancel >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-03T08:00:00Z "$TASKCTL" recurrence materialize >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD="{\"id\":\"$RID\"}" "$TASKCTL" recurrence get | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(JSON.parse(s).recurrence.status!=="ACTIVE")process.exit(1)})'

# Schema-v5 migration fault is all-or-nothing; a later successful migration preserves the row.
PRE="$TMP/predecessor.sqlite3"; BASE=d6dbae6848989f8611ca8931dd200bbc63868b35; REPO=$(cd "$ROOT/../.." && pwd)
git -C "$REPO" show "$BASE:agents/tasks/taskctl" > "$TMP/old-taskctl"; chmod +x "$TMP/old-taskctl"
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PRE" "$TMP/old-taskctl" init >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PRE" TASKCTL_PAYLOAD='{"operation_key":"old","title":"Preserve","assignee":"Дубровин М."}' "$TMP/old-taskctl" task create >/dev/null
set +e
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_TEST_MIGRATION_FAULT=after-recurrence-ddl TASKCTL_DB="$PRE" "$TASKCTL" health >/dev/null
[ $? -ne 0 ] || exit 1
set -e
node - "$PRE" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{if(Number(db.prepare('pragma user_version').get().user_version)!==5||db.prepare("select count(*) n from tasks where title='Preserve'").get().n!==1||db.prepare("select name from sqlite_master where type='table' and name='recurrences'").get())process.exit(1);}finally{db.close();}
NODE
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PRE" "$TASKCTL" health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.schema_version!==6||x.counts.tasks!==1||x.counts.recurrences!==0)process.exit(1)})'

printf 'TASK_AGENT_RECURRENCE_QUALIFICATION_PASS\n'
