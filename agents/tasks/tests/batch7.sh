#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASKCTL=${1:-$ROOT/taskctl}
PREDECESSOR_SHA=${TASK_BATCH7_PREDECESSOR_SHA:-c8fc1df5d77cb15a8dfd567ca76fb29bcb6fec8a}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
NOW="2026-09-03T12:00:00Z"
DB="$TMP/projects.sqlite3"

run(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$NOW" TASKCTL_PAYLOAD="$1" node "$TASKCTL" "$2" "$3"; }
plain(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$NOW" node "$TASKCTL" "$@"; }
contains(){ [[ "$1" == *"$2"* ]] || { echo "missing: $2" >&2; echo "$1" >&2; exit 1; }; }
json_assert(){ node -e "$1" "$2"; }

# TA-PRJ-001..040 deterministic Project entity, lifecycle, association, and progress contract.
a=$(plain init); contains "$a" '"implementation_version":"0.4.14"'; contains "$a" '"schema_version":9'

p1=$(run '{"operation_key":"p1","title":"  Внедрить ИИ-обзор задач  "}' project create)
contains "$p1" '"id":"PRJ-1"'; contains "$p1" '"title":"Внедрить ИИ-обзор задач"'; contains "$p1" '"status":"ACTIVE"'; contains "$p1" '"total":0'
p1_replay=$(run '{"operation_key":"p1","title":"  Внедрить ИИ-обзор задач  "}' project create); contains "$p1_replay" '"idempotent_replay":true'
p2=$(run '{"operation_key":"p2","title":"Другой проект"}' project create); contains "$p2" '"id":"PRJ-2"'
p3=$(run '{"operation_key":"p3","title":"Пустой проект"}' project create); contains "$p3" '"id":"PRJ-3"'; contains "$p3" '"total":0'
set +e
bare_project=$(run '{"id":1}' project get); bare_project_rc=$?
bare_project_string=$(run '{"id":"1"}' project get); bare_project_string_rc=$?
set -e
[ "$bare_project_rc" -ne 0 ] && contains "$bare_project" '"code":"INVALID_ID"'
[ "$bare_project_string_rc" -ne 0 ] && contains "$bare_project_string" '"code":"INVALID_ID"'

active=$(run '{}' project list); contains "$active" '"count":3'; contains "$active" '"id":"PRJ-1"'
search=$(run '{"search":"ии-обзор"}' project list); contains "$search" '"count":1'; contains "$search" '"id":"PRJ-1"'

run '{"operation_key":"label","display_name":"ИИ","emoji":"🤖"}' label create >/dev/null
t1=$(run '{"operation_key":"t1","title":"Подготовить обзор","assignee":"Дубровин М.","labels":["L-1"],"project_id":"PRJ-1"}' task create)
contains "$t1" '"project_id":"PRJ-1"'; contains "$t1" '"project_title":"Внедрить ИИ-обзор задач"'
detail=$(run '{"id":"T-1"}' task detail); contains "$detail" '"project_id":"PRJ-1"'; contains "$detail" '"display_name":"ИИ"'
p1d=$(run '{"id":"PRJ-1"}' project get); contains "$p1d" '"total":1'; contains "$p1d" '"OPEN":1'; contains "$p1d" '"id":"T-1"'

# All Task closure does not close the Project; progress remains derived.
run '{"operation_key":"t1-done","id":"T-1"}' task complete >/dev/null
p1d=$(run '{"id":"PRJ-1"}' project get); contains "$p1d" '"status":"ACTIVE"'; contains "$p1d" '"OPEN":0'; contains "$p1d" '"DONE":1'

# Association mutation works for a DONE Task and atomically moves A -> B.
move=$(run '{"operation_key":"move","task_id":"T-1","project_id":"PRJ-2"}' task-project set)
contains "$move" '"previous_project_id":"PRJ-1"'; contains "$move" '"project_id":"PRJ-2"'
move_replay=$(run '{"operation_key":"move","task_id":"T-1","project_id":"PRJ-2"}' task-project set); contains "$move_replay" '"idempotent_replay":true'
remove=$(run '{"operation_key":"remove","task_id":"T-1","project_id":null}' task-project set); contains "$remove" '"previous_project_id":"PRJ-2"'; contains "$remove" '"project_id":null'

t2=$(run '{"operation_key":"t2","title":"Открытая задача","assignee":"Дубровин М.","project_id":"PRJ-1"}' task create); contains "$t2" '"project_id":"PRJ-1"'
labels_before=$(run '{"id":"T-2"}' task detail)
complete=$(run '{"operation_key":"p1-done","id":"PRJ-1"}' project complete); contains "$complete" '"status":"DONE"'; contains "$complete" '"completed_at":"2026-09-03T12:00:00.000Z"'
t2_after=$(run '{"id":"T-2"}' task get); contains "$t2_after" '"status":"OPEN"'; contains "$t2_after" '"project_id":"PRJ-1"'

# Same-target lifecycle replay is a no-op; closed-state cross-transition fails closed.
repeat=$(run '{"operation_key":"p1-done-repeat","id":"PRJ-1"}' project complete); contains "$repeat" '"changed":false'
set +e
invalid_transition=$(run '{"operation_key":"p1-cancel","id":"PRJ-1"}' project cancel); rc=$?
set -e
[ "$rc" -ne 0 ]; contains "$invalid_transition" '"code":"INVALID_STATE"'

# A new association to a closed Project fails and preserves the previous valid association.
t3=$(run '{"operation_key":"t3","title":"Move guard","assignee":"Дубровин М.","project_id":"PRJ-2"}' task create); contains "$t3" '"project_id":"PRJ-2"'
set +e
failed_move=$(run '{"operation_key":"failed-move","task_id":"T-3","project_id":"PRJ-1"}' task-project set); rc=$?
set -e
[ "$rc" -ne 0 ]; contains "$failed_move" '"code":"INVALID_STATE"'
t3_after=$(run '{"id":"T-3"}' task get); contains "$t3_after" '"project_id":"PRJ-2"'

# Cancelling a Project keeps associated Tasks unchanged and closes only Project lifecycle.
cancel=$(run '{"operation_key":"p2-cancel","id":"PRJ-2"}' project cancel); contains "$cancel" '"status":"CANCELLED"'; contains "$cancel" '"completed_at":null'
t3_after=$(run '{"id":"T-3"}' task get); contains "$t3_after" '"status":"OPEN"'; contains "$t3_after" '"project_id":"PRJ-2"'

# Detaching from a closed Project remains valid.
detach=$(run '{"operation_key":"detach-closed","task_id":"T-3","project_id":null}' task-project set); contains "$detach" '"project_id":null'

# Project rename changes title only.
rename=$(run '{"operation_key":"rename-p3","id":"PRJ-3","title":"Пустой проект — новое имя"}' project rename); contains "$rename" '"title":"Пустой проект — новое имя"'; contains "$rename" '"status":"ACTIVE"'; contains "$rename" '"total":0'

# Cross-entity and nonexistent IDs fail without mutation.
set +e
bad_id=$(run '{"id":"T-1"}' project get); rc=$?
set -e
[ "$rc" -ne 0 ]; contains "$bad_id" '"code":"INVALID_ID"'
set +e
missing=$(run '{"operation_key":"missing","task_id":"T-9999","project_id":"PRJ-3"}' task-project set); rc=$?
set -e
[ "$rc" -ne 0 ]; contains "$missing" '"code":"NOT_FOUND"'

# No mutable persisted percent-complete exists and labels/history remain independent.
node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const projectCols=db.prepare('PRAGMA table_info(projects)').all().map(x=>x.name);
  if(projectCols.includes('percent_complete')||projectCols.includes('progress'))process.exit(2);
  const taskCols=db.prepare('PRAGMA table_info(tasks)').all().map(x=>x.name);
  if(taskCols.filter(x=>x==='project_id').length!==1)process.exit(3);
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')process.exit(4);
  if(db.prepare('PRAGMA foreign_key_check').all().length!==0)process.exit(5);
} finally { db.close(); }
NODE
labels_after=$(run '{"id":"T-2"}' task detail)
json_assert 'const a=JSON.parse(process.argv[1]);if(a.labels.length!==0||a.task.status!=="OPEN"||a.task.project_id!=="PRJ-1")process.exit(1)' "$labels_after"
json_assert 'const a=JSON.parse(process.argv[1]);if(a.labels.length!==0||a.task.status!=="OPEN")process.exit(1)' "$labels_before"

printf 'BATCH7_OK\n'
