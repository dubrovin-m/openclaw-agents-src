#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONTACTCTL="$ROOT/../../shared/contacts/contactctl"
TMP=$(mktemp -d /tmp/task-agent-batch5.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/tasks.sqlite3"
NOW="2026-08-30T09:00:00Z"

run() {
  local scope=$1 action=$2 payload=${3:-'{}'}
  TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$NOW" TASKCTL_PAYLOAD="$payload" "$ROOT/taskctl" "$scope" "$action"
}
crun() { CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$TMP/contacts.sqlite3" CONTACTCTL_PAYLOAD="$2" "$CONTACTCTL" "$1"; }

TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$NOW" "$ROOT/taskctl" init >/dev/null
SELF=$(run person resolve '{"reference":"Дубровин М."}')
SELF_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).matches[0].id)' "$SELF")
crun group_create '{"operation_key":"b5:office-group","display_name":"Office CEO"}' >/dev/null
crun group_member_add "{\"operation_key\":\"b5:office-self\",\"group_id\":\"PG-1\",\"person\":\"$SELF_ID\"}" >/dev/null
run config set '{"operation_key":"b5:bind-office","key":"OFFICE_CEO_GROUP","entity_id":"PG-1"}' >/dev/null

create_task() {
  local key=$1 title=$2 due=$3 label=${4:-}
  local payload
  if [ "$due" = null ]; then
    if [ -n "$label" ]; then payload=$(printf '{"operation_key":"%s","title":"%s","assignee_id":"%s","labels":["%s"]}' "$key" "$title" "$SELF_ID" "$label")
    else payload=$(printf '{"operation_key":"%s","title":"%s","assignee_id":"%s"}' "$key" "$title" "$SELF_ID"); fi
  else
    if [ -n "$label" ]; then payload=$(printf '{"operation_key":"%s","title":"%s","assignee_id":"%s","due_date":"%s","labels":["%s"]}' "$key" "$title" "$SELF_ID" "$due" "$label")
    else payload=$(printf '{"operation_key":"%s","title":"%s","assignee_id":"%s","due_date":"%s"}' "$key" "$title" "$SELF_ID" "$due"); fi
  fi
  run task create "$payload"
}

# BL-018: natural today view is OPEN due_date <= local today; due_on remains exact-date.
TODAY_LABEL=$(run label create '{"operation_key":"b5:today-label","display_name":"Today fixture","emoji":"🗓"}')
TODAY_LABEL_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$TODAY_LABEL")
run config set "{\"operation_key\":\"b5:bind-personal\",\"key\":\"PERSONAL_LABEL\",\"entity_id\":\"$TODAY_LABEL_ID\"}" >/dev/null
OVERDUE=$(create_task 'b5:t-overdue' 'Overdue' '2026-08-28' "$TODAY_LABEL_ID")
YESTERDAY=$(create_task 'b5:t-yesterday' 'Yesterday' '2026-08-29' "$TODAY_LABEL_ID")
TODAY=$(create_task 'b5:t-today' 'Today' '2026-08-30' "$TODAY_LABEL_ID")
FUTURE=$(create_task 'b5:t-future' 'Future' '2026-08-31')
UNDATED=$(create_task 'b5:t-undated' 'Undated' null)
DONE=$(create_task 'b5:t-done' 'Done today' '2026-08-30' "$TODAY_LABEL_ID")
DONE_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).task.id)' "$DONE")
run task complete "{\"operation_key\":\"b5:done\",\"id\":\"$DONE_ID\"}" >/dev/null
CANCELLED=$(create_task 'b5:t-cancelled' 'Cancelled today' '2026-08-30' "$TODAY_LABEL_ID")
CANCELLED_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).task.id)' "$CANCELLED")
run task cancel "{\"operation_key\":\"b5:cancel\",\"id\":\"$CANCELLED_ID\"}" >/dev/null

TODAY_VIEW=$(run task list '{"view":"today"}')
node - "$TODAY_VIEW" <<'NODE'
const x=JSON.parse(process.argv[2]);
const titles=x.tasks.map(t=>t.title).sort();
const expected=['Overdue','Today','Yesterday'].sort();
if(x.local_date!=='2026-08-30'||JSON.stringify(titles)!==JSON.stringify(expected))process.exit(1);
if(x.tasks.some(t=>t.status!=='OPEN'||t.due_date===null||t.due_date>'2026-08-30'))process.exit(1);
NODE
EXACT=$(run task list '{"due_on":"2026-08-30"}')
node - "$EXACT" <<'NODE'
const x=JSON.parse(process.argv[2]);
if(x.tasks.length!==1||x.tasks[0].title!=='Today'||x.tasks[0].due_date!=='2026-08-30')process.exit(1);
NODE

# BL-019: resolution exposes association consequence across all Task statuses.
RESOLVE=$(run label resolve '{"reference":"Today fixture"}')
node - "$RESOLVE" <<'NODE'
const x=JSON.parse(process.argv[2]);
if(!x.ok||x.count!==1||x.ambiguous||x.matches[0].task_association_count!==5)process.exit(1);
NODE

# Deleting an unused canonical Label removes the entity cleanly.
UNUSED=$(run label create '{"operation_key":"b5:unused","display_name":"Unused","emoji":"🧹"}')
UNUSED_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$UNUSED")
UNUSED_DEL=$(run label delete "{\"operation_key\":\"b5:delete-unused\",\"id\":\"$UNUSED_ID\"}")
node - "$UNUSED_DEL" <<'NODE'
const x=JSON.parse(process.argv[2]);
if(!x.ok||x.task_association_count!==0||x.removed_task_label_relationships!==0||x.deleted.emoji!=="🧹")process.exit(1);
NODE

# Deleting a used Label removes associations/aliases but never rewrites Task rows.
run label alias_add "{\"operation_key\":\"b5:alias\",\"id\":\"$TODAY_LABEL_ID\",\"alias\":\"Сегодня fixture\"}" >/dev/null
TASKS_BEFORE=$(node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});process.stdout.write(JSON.stringify(d.prepare('SELECT * FROM tasks ORDER BY id').all()));d.close();
NODE
)
DELETE_USED=$(run label delete "{\"operation_key\":\"b5:delete-used\",\"id\":\"$TODAY_LABEL_ID\"}")
node - "$DELETE_USED" <<'NODE'
const x=JSON.parse(process.argv[2]);
if(!x.ok||x.task_association_count!==5||x.removed_task_label_relationships!==5||x.deleted.display_name!=='Today fixture'||x.deleted.emoji!=="🗓")process.exit(1);
NODE
TASKS_AFTER=$(node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});process.stdout.write(JSON.stringify(d.prepare('SELECT * FROM tasks ORDER BY id').all()));d.close();
NODE
)
test "$TASKS_BEFORE" = "$TASKS_AFTER"
node - "$DB" "$TODAY_LABEL_ID" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});const id=Number(process.argv[3].split('-')[1]);
if(d.prepare('SELECT count(*) n FROM labels WHERE id=?').get(id).n!==0)process.exit(1);
if(d.prepare('SELECT count(*) n FROM label_aliases WHERE label_id=?').get(id).n!==0)process.exit(1);
if(d.prepare('SELECT count(*) n FROM task_labels WHERE label_id=?').get(id).n!==0)process.exit(1);
d.close();
NODE

# operation_key replay succeeds without re-deleting; conflicting reuse fails closed.
REPLAY=$(run label delete "{\"operation_key\":\"b5:delete-used\",\"id\":\"$TODAY_LABEL_ID\"}")
node - "$REPLAY" <<'NODE'
const x=JSON.parse(process.argv[2]);if(!x.ok||x.idempotent_replay!==true||x.task_association_count!==5)process.exit(1);
NODE
OTHER_LABEL=$(run label create '{"operation_key":"b5:other-label","display_name":"Other"}')
OTHER_LABEL_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$OTHER_LABEL")
set +e
CONFLICT=$(run label delete "{\"operation_key\":\"b5:delete-used\",\"id\":\"$OTHER_LABEL_ID\"}")
RC=$?
set -e
test "$RC" -ne 0
node -e 'const x=JSON.parse(process.argv[1]);if(x.error.code!=="IDEMPOTENCY_KEY_REUSE")process.exit(1)' "$CONFLICT"

# Atomic rollback: fail label-row deletion after relationship/alias deletion starts.
ROLL=$(run label create '{"operation_key":"b5:roll-label","display_name":"Rollback","emoji":"↩️"}')
ROLL_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$ROLL")
run label alias_add "{\"operation_key\":\"b5:roll-alias\",\"id\":\"$ROLL_ID\",\"alias\":\"RB\"}" >/dev/null
R1=$(create_task 'b5:roll-t1' 'Rollback one' '2026-08-30' "$ROLL_ID")
R2=$(create_task 'b5:roll-t2' 'Rollback two' '2026-08-31' "$ROLL_ID")
node - "$DB" "$ROLL_ID" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2]);const id=Number(process.argv[3].split('-')[1]);d.exec(`CREATE TRIGGER fail_batch5_label_delete BEFORE DELETE ON labels WHEN OLD.id=${id} BEGIN SELECT RAISE(ABORT,'batch5 rollback fixture'); END;`);d.close();
NODE
set +e
ROLL_FAIL=$(run label delete "{\"operation_key\":\"b5:delete-rollback\",\"id\":\"$ROLL_ID\"}")
RC=$?
set -e
test "$RC" -ne 0
node - "$DB" "$ROLL_ID" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});const id=Number(process.argv[3].split('-')[1]);
if(d.prepare('SELECT count(*) n FROM labels WHERE id=?').get(id).n!==1)process.exit(1);
if(d.prepare('SELECT count(*) n FROM label_aliases WHERE label_id=?').get(id).n!==1)process.exit(1);
if(d.prepare('SELECT count(*) n FROM task_labels WHERE label_id=?').get(id).n!==2)process.exit(1);
if(d.prepare("SELECT count(*) n FROM operation_results WHERE operation_key='b5:delete-rollback'").get().n!==0)process.exit(1);
d.close();
NODE

# Existing task_label_remove remains relationship-only.
REL=$(run label create '{"operation_key":"b5:rel-label","display_name":"Relationship"}')
REL_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$REL")
OPEN_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).task.id)' "$OVERDUE")
run task-label add "{\"operation_key\":\"b5:rel-add\",\"task_id\":\"$OPEN_ID\",\"label_id\":\"$REL_ID\"}" >/dev/null
run task-label remove "{\"operation_key\":\"b5:rel-remove\",\"task_id\":\"$OPEN_ID\",\"label_id\":\"$REL_ID\"}" >/dev/null
REL_RESOLVE=$(run label resolve '{"reference":"Relationship"}')
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||x.matches[0].task_association_count!==0)process.exit(1)' "$REL_RESOLVE"

# Existing label_merge still preserves/deduplicates relationships.
MERGE_A=$(run label create '{"operation_key":"b5:merge-a","display_name":"Merge A","emoji":"🔗"}')
MERGE_B=$(run label create '{"operation_key":"b5:merge-b","display_name":"Merge B"}')
MERGE_A_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$MERGE_A")
MERGE_B_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$MERGE_B")
run task-label add "{\"operation_key\":\"b5:merge-add-a\",\"task_id\":\"$OPEN_ID\",\"label_id\":\"$MERGE_A_ID\"}" >/dev/null
run task-label add "{\"operation_key\":\"b5:merge-add-b\",\"task_id\":\"$OPEN_ID\",\"label_id\":\"$MERGE_B_ID\"}" >/dev/null
MERGED=$(run label merge "{\"operation_key\":\"b5:merge\",\"from_id\":\"$MERGE_A_ID\",\"into_id\":\"$MERGE_B_ID\"}")
node - "$MERGED" <<'NODE'
const x=JSON.parse(process.argv[2]);if(!x.ok||x.label.emoji!=="🔗")process.exit(1);
NODE
node - "$DB" "$OPEN_ID" "$MERGE_B_ID" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});const tid=Number(process.argv[3].split('-')[1]),lid=Number(process.argv[4].split('-')[1]);if(d.prepare('SELECT count(*) n FROM task_labels WHERE task_id=? AND label_id=?').get(tid,lid).n!==1)process.exit(1);d.close();
NODE

# Batch 5 behavior remains valid on the current schema generation.
node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});if(Number(d.prepare('PRAGMA user_version').get().user_version)!==9)process.exit(1);if(d.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')process.exit(1);if(d.prepare('PRAGMA foreign_key_check').all().length!==0)process.exit(1);d.close();
NODE

printf 'BATCH5_DETERMINISTIC_PASS\n'
