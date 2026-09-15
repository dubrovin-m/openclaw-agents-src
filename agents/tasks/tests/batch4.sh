#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/task-agent-batch4.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/tasks.sqlite3"

run() {
  local scope=$1 action=$2 payload=${3:-'{}'}
  TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="2026-08-25T09:00:00Z" TASKCTL_PAYLOAD="$payload" "$ROOT/taskctl" "$scope" "$action"
}

TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="2026-08-25T09:00:00Z" "$ROOT/taskctl" init >/dev/null

SELF=$(run person resolve '{"reference":"Дубровин М."}')
node -e 'const x=JSON.parse(process.argv[1]);if(!x.ok||x.count!==1)process.exit(1)' "$SELF"
SELF_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).matches[0].id)' "$SELF")
OTHER=$(run person create '{"operation_key":"b4:person","display_name":"Иванов И."}')
OTHER_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).person.id)' "$OTHER")

# Label emoji CRUD.
L1=$(run label create '{"operation_key":"b4:l1","display_name":"Совет директоров","emoji":"🏛"}')
L1_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$L1")
node -e 'const x=JSON.parse(process.argv[1]);if(x.label.emoji!=="🏛")process.exit(1)' "$L1"
run label alias_add "{\"operation_key\":\"b4:alias\",\"id\":\"$L1_ID\",\"alias\":\"СД\"}" >/dev/null
ALIAS=$(run label resolve '{"reference":"СД"}')
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||x.matches[0].emoji!=="🏛")process.exit(1)' "$ALIAS"

L2=$(run label create '{"operation_key":"b4:l2","display_name":"Бюджет","emoji":"💰"}')
L3=$(run label create '{"operation_key":"b4:l3","display_name":"Право","emoji":"⚖️"}')
L4=$(run label create '{"operation_key":"b4:l4","display_name":"Риск","emoji":"⚠️"}')
L2_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$L2")
L3_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$L3")
L4_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$L4")

# Self and delegated current-assignee signals come from operational state.
SELF_TASK=$(run task create "{\"operation_key\":\"b4:self-task\",\"title\":\"Self fixture\",\"assignee_id\":\"$SELF_ID\",\"due_date\":\"2026-09-01\",\"labels\":[\"$L1_ID\",\"$L2_ID\",\"$L3_ID\",\"$L4_ID\"]}")
SELF_TASK_ID=$(node -e 'const x=JSON.parse(process.argv[1]);if(x.task.assignee_is_self!==true)process.exit(1);process.stdout.write(x.task.id)' "$SELF_TASK")
OTHER_TASK=$(run task create "{\"operation_key\":\"b4:other-task\",\"title\":\"Delegated fixture\",\"assignee_id\":\"$OTHER_ID\",\"due_date\":\"2026-09-01\"}")
OTHER_TASK_ID=$(node -e 'const x=JSON.parse(process.argv[1]);if(x.task.assignee_is_self!==false)process.exit(1);process.stdout.write(x.task.id)' "$OTHER_TASK")

# Up to 3 distinct emoji are derived in deterministic canonical Label order; detail keeps all Labels.
LIST=$(run task get "{\"id\":\"$SELF_TASK_ID\"}")
node -e 'const x=JSON.parse(process.argv[1]);if(x.task.label_emojis.length!==3||new Set(x.task.label_emojis).size!==3)process.exit(1)' "$LIST"
DETAIL=$(run task detail "{\"id\":\"$SELF_TASK_ID\"}")
node -e 'const x=JSON.parse(process.argv[1]);if(x.labels.length!==4)process.exit(1)' "$DETAIL"

# Emoji removal changes subsequent presentation without rewriting Task/TaskLabel relationships.
BEFORE=$(node - "$DB" "$SELF_TASK_ID" <<'JS'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});const id=Number(process.argv[3].split('-')[1]);const t=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);const l=d.prepare('SELECT task_id,label_id FROM task_labels WHERE task_id=? ORDER BY label_id').all(id);process.stdout.write(JSON.stringify({t,l}));d.close();
JS
)
run label set_emoji "{\"operation_key\":\"b4:remove-emoji\",\"id\":\"$L1_ID\",\"emoji\":null}" >/dev/null
AFTER=$(node - "$DB" "$SELF_TASK_ID" <<'JS'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});const id=Number(process.argv[3].split('-')[1]);const t=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);const l=d.prepare('SELECT task_id,label_id FROM task_labels WHERE task_id=? ORDER BY label_id').all(id);process.stdout.write(JSON.stringify({t,l}));d.close();
JS
)
test "$BEFORE" = "$AFTER"
REMOVED=$(run task get "{\"id\":\"$SELF_TASK_ID\"}")
node -e 'const x=JSON.parse(process.argv[1]);if(x.task.label_emojis.includes("🏛"))process.exit(1)' "$REMOVED"

# Deadline events accept supplied reason and explicit no-reason storage for both self and delegated tasks.
run task update "{\"operation_key\":\"b4:self-move\",\"id\":\"$SELF_TASK_ID\",\"due_date\":\"2026-09-02\",\"reason\":null}" >/dev/null
run task update "{\"operation_key\":\"b4:other-move\",\"id\":\"$OTHER_TASK_ID\",\"due_time\":\"10:00\",\"reason\":\"ждем данные\"}" >/dev/null
SELF_H=$(run task history "{\"id\":\"$SELF_TASK_ID\"}")
OTHER_H=$(run task history "{\"id\":\"$OTHER_TASK_ID\"}")
node -e 'const x=JSON.parse(process.argv[1]);const e=x.events.find(e=>e.event_type==="DUE_DATE_CHANGED");if(!e||e.reason!==null)process.exit(1)' "$SELF_H"
node -e 'const x=JSON.parse(process.argv[1]);const e=x.events.find(e=>e.event_type==="DUE_TIME_CHANGED");if(!e||e.reason!=="ждем данные")process.exit(1)' "$OTHER_H"

# Conflicting emoji merge fails closed.
C1=$(run label create '{"operation_key":"b4:c1","display_name":"Conflict A","emoji":"🅰️"}')
C2=$(run label create '{"operation_key":"b4:c2","display_name":"Conflict B","emoji":"🅱️"}')
C1_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$C1")
C2_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).label.id)' "$C2")
set +e
CONFLICT=$(run label merge "{\"operation_key\":\"b4:conflict\",\"from_id\":\"$C1_ID\",\"into_id\":\"$C2_ID\"}")
RC=$?
set -e
if [ "$RC" -eq 0 ]; then echo "conflicting label merge unexpectedly succeeded" >&2; exit 1; fi
node -e 'const x=JSON.parse(process.argv[1]);if(x.error.code!=="LABEL_EMOJI_CONFLICT")process.exit(1)' "$CONFLICT"

printf 'BATCH4_DETERMINISTIC_PASS\n'
bash "$ROOT/tests/batch5.sh"
