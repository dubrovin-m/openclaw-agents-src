#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
TASKCTL="$ROOT/taskctl"
EXPECTED_TASKCTL_VERSION=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.generation.taskctl_version)' "$ROOT/release.json")
CONTACTCTL="$REPO_ROOT/shared/contacts/contactctl"
TMP=$(mktemp -d /tmp/task-deadline-governance.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
TDB="$TMP/tasks.sqlite3"
CDB="$TMP/contacts.sqlite3"
NOW=2026-09-22T09:00:00Z
t(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TDB" TASKCTL_CONTACTS_DB="$CDB" TASKCTL_TEST_NOW="$NOW" TASKCTL_PAYLOAD="$1" "$TASKCTL" "$2" "$3"; }
c(){ CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$CDB" CONTACTCTL_PAYLOAD="$1" "$CONTACTCTL" "$2"; }

read -r TARGET_TASKCTL TARGET_SCHEMA <<<"$(node - "$ROOT/release.json" <<'NODE'
const r=require(process.argv[2]);process.stdout.write([r.generation.taskctl_version,r.generation.sqlite_schema].join(' '));
NODE
)"
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TDB" TASKCTL_CONTACTS_DB="$CDB" "$TASKCTL" init |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.implementation_version!==process.argv[1]||x.schema_version!==Number(process.argv[2]))process.exit(1)})' "$TARGET_TASKCTL" "$TARGET_SCHEMA"
c '{"operation_key":"g","display_name":"Office CEO"}' group_create >/dev/null
c '{"operation_key":"p","display_name":"Иванов И."}' create >/dev/null
c '{"operation_key":"gm","group_id":"PG-1","person":"P-1"}' group_member_add >/dev/null
t '{"operation_key":"home","display_name":"Дом","emoji":"🏠"}' label create >/dev/null
t '{"operation_key":"work","display_name":"Работа","emoji":"💼"}' label create >/dev/null
t '{"operation_key":"bg","key":"OFFICE_CEO_GROUP","entity_id":"PG-1"}' config set >/dev/null
t '{"operation_key":"bl","key":"PERSONAL_LABEL","entity_id":"L-1"}' config set >/dev/null
t '{"operation_key":"office","title":"Office today","assignee":"P-1","due_date":"2026-09-22"}' task create >/dev/null
t '{"operation_key":"team","title":"Team today","assignee":"P-2","due_date":"2026-09-22","due_time":"16:00"}' task create >/dev/null
t '{"operation_key":"personal","title":"Personal today","assignee":"P-1","due_date":"2026-09-22","due_time":"19:00"}' task create >/dev/null
t '{"operation_key":"personal-label","task_id":"T-3","label_id":"L-1"}' task-label add >/dev/null
t '{"operation_key":"late","title":"Late external","assignee":"P-2","due_date":"2026-09-20"}' task create >/dev/null
t '{"operation_key":"request","task_id":"T-4","due_date":"2026-10-04","reason":"Ждет данные"}' deadline-request create >/dev/null

set +e
blocked=$(t '{"operation_key":"bypass","id":"T-4","due_date":"2026-09-29"}' task update); blocked_rc=$?
set -e
[ "$blocked_rc" -ne 0 ]
node -e 'const x=JSON.parse(process.argv[1]);if(x.error?.code!=="DEADLINE_REQUEST_PENDING")process.exit(1)' "$blocked"

today=$(t '{"view":"today"}' task list)
node - "$today" <<'NODE'
const x=JSON.parse(process.argv[2]);
const by=Object.fromEntries(x.tasks.map(t=>[t.title,t]));
if(x.today_view!==true||x.count!==4)process.exit(1);
if(by["Late external"].today_section!=="OVERDUE"||by["Late external"].due_date!=="2026-09-20")process.exit(2);
if(by["Late external"].pending_deadline_change_request?.requested_due_date!=="2026-10-04")process.exit(3);
if(by["Office today"].today_section!=="OFFICE_CEO")process.exit(4);
if(by["Team today"].today_section!=="TEAM")process.exit(5);
if(by["Personal today"].today_section!=="PERSONAL")process.exit(6);
NODE
review=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TDB" TASKCTL_CONTACTS_DB="$CDB" TASKCTL_PAYLOAD='{"boundary":"2026-09-22T09:00:00.000Z"}' "$TASKCTL" review snapshot)
node - "$review" <<'NODE'
const x=JSON.parse(process.argv[2]),by=Object.fromEntries(x.tasks.map(t=>[t.title,t]));
if(x.schema_version!==9||by["Office today"].office_ceo!==true||by["Personal today"].personal!==true)process.exit(1);
if(by["Late external"].pending_deadline_change_request?.reason!=="Ждет данные")process.exit(2);
NODE

t '{"operation_key":"complete","title":"Done today","assignee":"P-2","status":"DONE","due_date":"2026-09-22"}' task create >/dev/null
t '{"operation_key":"comment","task_id":"T-2","content":"Не получены данные от подрядчика"}' comment add >/dev/null
management=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TDB" TASKCTL_CONTACTS_DB="$CDB" TASKCTL_PAYLOAD='{"boundary":"2026-09-22T09:00:00.000Z"}' "$TASKCTL" review management-snapshot)
node - "$management" <<'NODE'
const x=JSON.parse(process.argv[2]);
if(x.completed_count!==1||!x.completed.some(t=>t.title==="Done today"))process.exit(1);
if(x.not_completed.some(t=>t.title==="Office today"||t.title==="Personal today"))process.exit(2);
const late=x.not_completed.find(t=>t.title==="Late external");
const team=x.not_completed.find(t=>t.title==="Team today");
if(late?.pending_deadline_change_request?.requested_due_date!=="2026-10-04")process.exit(3);
if(team?.comments?.[0]?.content!=="Не получены данные от подрядчика")process.exit(4);
NODE
t '{"operation_key":"partial","task_id":"T-4","due_date":"2026-09-27"}' deadline-request approve |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.request.requested_due_date!=="2026-10-04"||x.request.approved_due_date!=="2026-09-27"||x.task.due_date!=="2026-09-27"||x.modified_from_request!==true)process.exit(1)})'
t '{"task_id":"T-4"}' deadline-request get |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.pending!==null||x.history.length!==1||x.history[0].status!=="APPROVED")process.exit(1)})'

# PERSONAL_LABEL is a durable binding: direct deletion is forbidden and merge repoints it.
set +e
bound_delete=$(t '{"operation_key":"bound-delete","id":"L-1"}' label delete); bound_delete_rc=$?
set -e
[ "$bound_delete_rc" -ne 0 ]
node -e 'const x=JSON.parse(process.argv[1]);if(x.error?.code!=="BOUND_LABEL_DELETE_FORBIDDEN")process.exit(1)' "$bound_delete"
t '{"operation_key":"replacement-label","display_name":"Личное новое"}' label create >/dev/null
t '{"operation_key":"merge-personal","from_id":"L-1","into_id":"L-3"}' label merge |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.personal_label_rebound!==true||x.label.id!=="L-3")process.exit(1)})'
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TDB" TASKCTL_CONTACTS_DB="$CDB" TASKCTL_PAYLOAD='{}' "$TASKCTL" config validate |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.personal_label_id!=="L-3"||x.office_ceo_group_id!=="PG-1")process.exit(1)})'
t '{"view":"today"}' task list |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s),p=x.tasks.find(t=>t.title==="Personal today");if(p?.today_section!=="PERSONAL")process.exit(1)})'

t '{"operation_key":"terminal-task","title":"Terminal pending","assignee":"P-2","due_date":"2026-09-22"}' task create >/dev/null
t '{"operation_key":"terminal-request","task_id":"T-6","due_date":"2026-09-30","reason":"Ждет решение"}' deadline-request create >/dev/null
t '{"operation_key":"terminal-complete","id":"T-6"}' task complete |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.task.status!=="DONE"||x.closed_deadline_request?.status!=="SUPERSEDED")process.exit(1)})'
t '{"task_id":"T-6"}' deadline-request get |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.pending!==null||x.history[0]?.status!=="SUPERSEDED")process.exit(1)})'

printf 'DEADLINE_GOVERNANCE_PASS\n'
