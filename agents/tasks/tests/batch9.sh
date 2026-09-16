#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASKCTL=${1:-$ROOT/taskctl}
TMP=$(mktemp -d /tmp/task-agent-batch9.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
DB="$TMP/tasks.sqlite3"
run(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$1" TASKCTL_PAYLOAD="$2" "$TASKCTL" "$3" "$4"; }
init=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-08T07:00:00Z "$TASKCTL" init)
node -e 'const x=JSON.parse(process.argv[1]);if(x.schema_version!==7||x.implementation_version!=="0.4.10")process.exit(1)' "$init"

# Existing entities.
SELF=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD='{}' "$TASKCTL" person list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.stdout.write(x.people.find(p=>p.display_name==="Дубровин М.").id)})')
L=$(run 2026-09-08T07:00:00Z '{"operation_key":"l1","display_name":"Дом"}' label create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).label.id))')
P=$(run 2026-09-08T07:00:00Z '{"operation_key":"p1","title":"Дом"}' project create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).project.id))')

# TA-REC-002/003/007/008/011/012/014: calendar Recurrence and replay-safe materialization.
CAL=$(run 2026-09-08T07:00:00Z "{\"operation_key\":\"r1\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"DAYS\",\"interval\":1,\"start_date\":\"2026-09-08\"},\"title\":\"Ежедневная задача\",\"assignee_id\":\"$SELF\",\"label_ids\":[\"$L\"],\"target_project_id\":\"$P\",\"due_time\":\"18:00\"}" recurrence create)
RID=$(node -e 'const x=JSON.parse(process.argv[1]);if(x.recurrence.status!=="ACTIVE"||x.recurrence.mode!=="CALENDAR"||x.recurrence.template.due_time!=="18:00"||x.first_occurrence===null)process.exit(1);process.stdout.write(x.recurrence.id)' "$CAL")
TASK=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.first_occurrence.task_id)' "$CAL")
DETAIL=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD="{\"id\":\"$TASK\"}" "$TASKCTL" task get)
node -e 'const x=JSON.parse(process.argv[1]);if(x.task.due_date!=="2026-09-08"||x.task.due_time!=="18:00"||x.task.recurrence?.recurrence_id!==process.argv[2])process.exit(1)' "$DETAIL" "$RID"
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-08T08:00:00Z "$TASKCTL" recurrence materialize >/dev/null
node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});try{if(db.prepare('select count(*) n from recurrence_occurrences').get().n!==1)process.exit(1);}finally{db.close();}
NODE

# TA-REC-009/010: future-only template mutation and independent Task state.
run 2026-09-08T08:00:00Z "{\"operation_key\":\"r-update\",\"id\":\"$RID\",\"title\":\"Новый заголовок\"}" recurrence update >/dev/null
OLD=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD="{\"id\":\"$TASK\"}" "$TASKCTL" task get)
node -e 'if(JSON.parse(process.argv[1]).task.title!=="Ежедневная задача")process.exit(1)' "$OLD"
run 2026-09-08T08:00:00Z "{\"operation_key\":\"task-edit\",\"id\":\"$TASK\",\"title\":\"Изменено только в задаче\"}" task update >/dev/null
REC=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD="{\"id\":\"$RID\"}" "$TASKCTL" recurrence get)
node -e 'if(JSON.parse(process.argv[1]).recurrence.template.title!=="Новый заголовок")process.exit(1)' "$REC"

# TA-REC-016/017: paused slots skipped, no backfill.
run 2026-09-08T09:00:00Z "{\"operation_key\":\"pause\",\"id\":\"$RID\"}" recurrence pause >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-10T08:00:00Z "$TASKCTL" recurrence materialize >/dev/null
run 2026-09-10T08:00:00Z "{\"operation_key\":\"resume\",\"id\":\"$RID\"}" recurrence resume >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW=2026-09-11T08:00:00Z "$TASKCTL" recurrence materialize >/dev/null
node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});try{const dates=db.prepare("select occurrence_date from recurrence_occurrences where recurrence_id=1 order by occurrence_date").all().map(x=>x.occurrence_date);if(JSON.stringify(dates)!==JSON.stringify(['2026-09-08','2026-09-11']))process.exit(1);}finally{db.close();}
NODE

# TA-REC-018/019: cancellation terminal.
run 2026-09-10T09:00:00Z "{\"operation_key\":\"cancel-r\",\"id\":\"$RID\"}" recurrence cancel >/dev/null
set +e
run 2026-09-10T09:00:00Z "{\"operation_key\":\"resume-cancelled\",\"id\":\"$RID\"}" recurrence resume >/dev/null
[ $? -ne 0 ] || exit 1
set -e

# TA-REC-005/006/020/021/022: OPEN seed + AFTER_COMPLETION atomic successor based on completion date.
SEED=$(run 2026-09-08T07:00:00Z "{\"operation_key\":\"seed-task\",\"title\":\"Проверить фильтр\",\"assignee_id\":\"$SELF\",\"due_date\":\"2026-09-09\"}" task create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).task.id))')
AFTER=$(run 2026-09-08T07:00:00Z "{\"operation_key\":\"after-r\",\"mode\":\"AFTER_COMPLETION\",\"rule\":{\"interval\":100,\"unit\":\"DAYS\"},\"seed_task_id\":\"$SEED\"}" recurrence create)
ARID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).recurrence.id)' "$AFTER")
DONE=$(run 2026-09-12T21:30:00Z "{\"operation_key\":\"complete-seed\",\"id\":\"$SEED\"}" task complete)
SUCC=$(node -e 'const x=JSON.parse(process.argv[1]);if(!x.successor)process.exit(1);process.stdout.write(x.successor.id)' "$DONE")
node -e 'const x=JSON.parse(process.argv[1]);if(x.successor.due_date!=="2026-12-22")process.exit(1)' "$DONE"
REPLAY=$(run 2026-09-12T21:31:00Z "{\"operation_key\":\"complete-seed-replay-new-key\",\"id\":\"$SEED\"}" task complete)
node -e 'const x=JSON.parse(process.argv[1]);if(x.successor?.id!==process.argv[2])process.exit(1)' "$REPLAY" "$SUCC"

# TA-REC-023: month clamp Jan 31 + 1 month -> Feb 28 (2027 non-leap).
M=$(run 2027-01-01T07:00:00Z "{\"operation_key\":\"month-r\",\"mode\":\"AFTER_COMPLETION\",\"rule\":{\"interval\":1,\"unit\":\"MONTHS\"},\"title\":\"Месячная\",\"assignee_id\":\"$SELF\",\"first_due_date\":\"2027-01-31\"}" recurrence create)
MT=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).first_occurrence.task_id)' "$M")
MD=$(run 2027-01-31T20:00:00Z "{\"operation_key\":\"month-complete\",\"id\":\"$MT\"}" task complete)
node -e 'if(JSON.parse(process.argv[1]).successor.due_date!=="2027-02-28")process.exit(1)' "$MD"

# TA-REC-024: complete while paused, resume anchors from resume date.
PSEED=$(run 2026-09-08T07:00:00Z "{\"operation_key\":\"paused-seed\",\"title\":\"Paused after\",\"assignee_id\":\"$SELF\"}" task create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).task.id))')
PR=$(run 2026-09-08T07:00:00Z "{\"operation_key\":\"paused-r\",\"mode\":\"AFTER_COMPLETION\",\"rule\":{\"interval\":2,\"unit\":\"WEEKS\"},\"seed_task_id\":\"$PSEED\"}" recurrence create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).recurrence.id))')
run 2026-09-08T08:00:00Z "{\"operation_key\":\"paused-pause\",\"id\":\"$PR\"}" recurrence pause >/dev/null
PDONE=$(run 2026-09-09T08:00:00Z "{\"operation_key\":\"paused-complete\",\"id\":\"$PSEED\"}" task complete)
node -e 'if(JSON.parse(process.argv[1]).successor!==null)process.exit(1)' "$PDONE"
PRES=$(run 2026-09-20T08:00:00Z "{\"operation_key\":\"paused-resume\",\"id\":\"$PR\"}" recurrence resume)
node -e 'if(JSON.parse(process.argv[1]).successor.due_date!=="2026-10-04")process.exit(1)' "$PRES"

# TA-REC-025/026: cancellation of occurrence does not mutate the series; AFTER flags resolution.
CSEED=$(run 2026-09-08T07:00:00Z "{\"operation_key\":\"cancel-seed\",\"title\":\"Cancel current\",\"assignee_id\":\"$SELF\"}" task create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).task.id))')
CR=$(run 2026-09-08T07:00:00Z "{\"operation_key\":\"cancel-after-r\",\"mode\":\"AFTER_COMPLETION\",\"rule\":{\"interval\":1,\"unit\":\"DAYS\"},\"seed_task_id\":\"$CSEED\"}" recurrence create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).recurrence.id))')
CT=$(run 2026-09-09T08:00:00Z "{\"operation_key\":\"cancel-current\",\"id\":\"$CSEED\"}" task cancel)
node -e 'const x=JSON.parse(process.argv[1]);if(x.recurrence_resolution_required!==true||x.recurrence_id!==process.argv[2])process.exit(1)' "$CT" "$CR"

# TA-REC-029/030: active target blocks Project closure, cancelled target does not.
BLOCK=$(run 2026-09-10T08:00:00Z "{\"operation_key\":\"blocker-r\",\"mode\":\"CALENDAR\",\"rule\":{\"kind\":\"DAYS\",\"interval\":1,\"start_date\":\"2026-09-10\"},\"title\":\"Project blocker\",\"assignee_id\":\"$SELF\",\"target_project_id\":\"$P\"}" recurrence create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).recurrence.id))')
set +e
run 2026-09-10T08:00:00Z "{\"operation_key\":\"close-blocked\",\"id\":\"$P\"}" project complete >/dev/null
[ $? -ne 0 ] || exit 1
set -e
run 2026-09-10T08:00:00Z "{\"operation_key\":\"cancel-blocker\",\"id\":\"$BLOCK\"}" recurrence cancel >/dev/null
run 2026-09-10T08:00:00Z "{\"operation_key\":\"close-project\",\"id\":\"$P\"}" project complete >/dev/null

# TA-REC-031/032: detail/history/list semantics and no bare R numeric IDs.
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD='{}' "$TASKCTL" recurrence list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.recurrences.some(r=>r.status!=="ACTIVE"))process.exit(1)})'
H=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD="{\"id\":\"$ARID\"}" "$TASKCTL" recurrence history)
node -e 'const x=JSON.parse(process.argv[1]);if(!x.events.some(e=>e.event_type==="CREATED"))process.exit(1)' "$H"
set +e
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD='{"id":1}' "$TASKCTL" recurrence get >/dev/null
[ $? -ne 0 ] || exit 1
set -e

# TA-REC-033/034: hidden materializer is not a model-visible action; DB owns domain identity.
node - "$ROOT/plugins/taskctl/src/contract.ts" <<'NODE'
const fs=require('fs'),s=fs.readFileSync(process.argv[2],'utf8');if(s.includes('recurrence_materialize'))process.exit(1);
NODE

# TA-REC-039: exact historical schema-v5 predecessor migrates additively with no synthetic Recurrences.
PRE="$TMP/predecessor.sqlite3"
BASE=d6dbae6848989f8611ca8931dd200bbc63868b35
REPO=$(cd "$ROOT/../.." && pwd)
if ! git -C "$REPO" cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  bridge_json=$(node "$ROOT/tests/verify-public-historical-fixture.mjs" schema5_source_revision "${BASE}" HEAD 2>&1) || { echo "public historical-fixture bridge verification failed: $bridge_json" >&2; exit 2; }
  printf '%s public-bootstrap-historical-fixture-omitted predecessor=%s\n' "TASK_AGENT_BATCH9_RECURRING_PASS" "${BASE}"
  exit 0
fi

git -C "$REPO" cat-file -e "$BASE^{commit}"
git -C "$REPO" show "$BASE:agents/tasks/taskctl" > "$TMP/old-taskctl"; chmod +x "$TMP/old-taskctl"
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PRE" "$TMP/old-taskctl" init >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PRE" TASKCTL_PAYLOAD='{"operation_key":"old-row","title":"Existing v5 Task","assignee":"Дубровин М."}' "$TMP/old-taskctl" task create >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$PRE" "$TASKCTL" health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.schema_version!==7||x.counts.tasks!==1||x.counts.recurrences!==0)process.exit(1)})'

printf 'TASK_AGENT_BATCH9_RECURRING_PASS\n'
