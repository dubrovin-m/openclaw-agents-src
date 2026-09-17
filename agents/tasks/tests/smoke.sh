#!/usr/bin/env bash
set -euo pipefail
umask 077
TASKCTL=${1:-./taskctl}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/tasks.sqlite3"
run(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_PAYLOAD="$1" node "$TASKCTL" "$2" "$3"; }
plain(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" node "$TASKCTL" "$@"; }
run_at(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$1" TASKCTL_PAYLOAD="$2" node "$TASKCTL" "$3" "$4"; }
contains(){ [[ "$1" == *"$2"* ]] || { echo "missing: $2" >&2; echo "$1" >&2; exit 1; }; }
expect_fail(){ local payload=$1 scope=$2 action=$3 needle=$4 output code; set +e; output=$(run "$payload" "$scope" "$action" 2>&1); code=$?; set -e; [ "$code" -ne 0 ] || { echo "expected failure: $scope $action" >&2; exit 1; }; contains "$output" "$needle"; }

plain init >/dev/null

# Canonical identity, alias reuse, ambiguity safety, and merge preservation:
# TA-ID-001..006, TA-FAIL-003.
a=$(run '{"reference":"Дубровин М."}' person resolve); contains "$a" '"count":1'
expect_fail '{"operation_key":"p-self-rename","id":"P-1","display_name":"Максим"}' person rename SELF_CONFLICT
a=$(run '{"operation_key":"p-create","display_name":"Дима"}' person create); contains "$a" '"id":"P-2"'; contains "$a" '"created":true'
run '{"operation_key":"p-alias","id":"P-2","alias":"Дмитрий"}' person alias_add >/dev/null
a=$(run '{"operation_key":"p-reuse","display_name":"дмитрий"}' person create); contains "$a" '"id":"P-2"'; contains "$a" '"created":false'
a=$(run '{"reference":"Дмитрий"}' person resolve); contains "$a" '"display_name":"Дима"'

# Canonical labels and explicit-only terminology:
# TA-LBL-001..006, TA-TERM-001, TA-TERM-002, TA-TERM-004.
a=$(run '{"operation_key":"l-create","display_name":"Совет директоров"}' label create); contains "$a" '"id":"L-1"'; contains "$a" '"created":true'
run '{"operation_key":"l-alias","id":"L-1","alias":"СД"}' label alias_add >/dev/null
a=$(run '{"operation_key":"l-reuse","display_name":"сд"}' label create); contains "$a" '"id":"L-1"'; contains "$a" '"created":false'
run '{"operation_key":"term-set","alias":"РГ","expansion":"рабочая группа по новому продукту"}' term set >/dev/null
a=$(run '{"alias":"РГ"}' term resolve); contains "$a" '"рабочая группа по новому продукту"'
run '{"operation_key":"term-correct","alias":"РГ","expansion":"рабочая группа"}' term set >/dev/null
a=$(run '{"alias":"РГ"}' term resolve); contains "$a" '"expansion":"рабочая группа"'

# Capture, replay, proposal non-persistence, and atomic Inbox commit:
# TA-CAP-001..003, TA-CAP-005..006, TA-CAP-008, TA-INB-003..010, TA-INB-015,
# TA-DEL-003, TA-FAIL-001..004.
run '{"operation_key":"cap","capture_key":"tg:1","content":"Дима бюджет для СД"}' inbox add >/dev/null
a=$(run '{"operation_key":"cap-replay","capture_key":"tg:1","content":"Дима бюджет для СД"}' inbox add); contains "$a" '"duplicate_capture":true'
a=$(run '{"operation_key":"commit","id":"I-1","tasks":[{"title":"Прислать бюджет","assignee":"Дмитрий","due_date":"2026-08-22","labels":["СД","СД"]}]}' inbox commit)
contains "$a" '"id":"T-1"'; contains "$a" '"assignee":"Дима"'

# Comments, detail/history, deadline reconstruction, search, and stable references:
# TA-TIME-001..007, TA-HIST-001..006, TA-COM-001..002, TA-CARD-002,
# TA-SRCH-001..003, TA-MUT-001..007, TA-MUT-009..011, TA-REF-001..005.
run '{"operation_key":"cm1","task_id":"T-1","content":"Ждем Минфин"}' comment add >/dev/null
run '{"operation_key":"cm2","task_id":"T-1","content":"Минфин обещал ответ завтра"}' comment add >/dev/null
run '{"operation_key":"mv1","id":"T-1","due_date":"2026-08-25","reason":"ждем данные"}' task update >/dev/null
run '{"operation_key":"tm1","id":"T-1","due_time":"10:00","reason":"назначили созвон"}' task update >/dev/null
a=$(run '{"id":"T-1"}' task detail)
contains "$a" '"original_deadline":{"due_date":"2026-08-22","due_time":null}'
contains "$a" '"deadline_change_count":2'; contains "$a" '"reason":"назначили созвон"'; contains "$a" '"Совет директоров"'
a=$(run '{"id":"T-1"}' task history); contains "$a" '"comments"'; contains "$a" '"reason":"ждем данные"'
a=$(run '{"search":"Минфин"}' task search); contains "$a" '"id":"T-1"'
a=$(run '{"search":"минфин"}' task search); contains "$a" '"id":"T-1"'
a=$(run '{"search":"СОВЕТ ДИРЕКТОРОВ"}' task search); contains "$a" '"id":"T-1"'
run '{"operation_key":"done","id":"T-1"}' task complete >/dev/null
a=$(run '{"search":"Минфин"}' task search); contains "$a" '"status":"DONE"'
a=$(run '{"label":"СД","status":"*"}' task list); contains "$a" '"id":"T-1"'
a=$(run '{"number":1,"context":"task"}' ref resolve); contains "$a" '"id":"T-1"'

run '{"operation_key":"t2","title":"Second","assignee":"Дубровин М."}' task create >/dev/null
run '{"operation_key":"cap2","capture_key":"tg:2","content":"another"}' inbox add >/dev/null
expect_fail '{"number":2,"context":"auto"}' ref resolve AMBIGUOUS_REFERENCE

run '{"operation_key":"p3","display_name":"Дмитрий Иванов"}' person create >/dev/null
run '{"operation_key":"pm","from_id":"P-3","into_id":"P-2"}' person merge >/dev/null
a=$(run '{"reference":"Дмитрий Иванов"}' person resolve); contains "$a" '"display_name":"Дима"'

# Unique canonical surname fallback, ambiguity safety, and exact-alias precedence.
a=$(run '{"operation_key":"surname-pobedinskaya","display_name":"Побединская Н."}' person create); contains "$a" '"created":true'
a=$(run '{"reference":"Побединская"}' person resolve); contains "$a" '"display_name":"Побединская Н."'
run '{"operation_key":"surname-alias","id":"P-4","alias":"Иванов"}' person alias_add >/dev/null
run '{"operation_key":"surname-ivanov-a","display_name":"Иванов А."}' person create >/dev/null
run '{"operation_key":"surname-ivanov-b","display_name":"Иванов Б."}' person create >/dev/null
a=$(run '{"reference":"Иванов"}' person resolve); contains "$a" '"display_name":"Побединская Н."'
run '{"operation_key":"surname-petrov-a","display_name":"Петров А."}' person create >/dev/null
run '{"operation_key":"surname-petrov-b","display_name":"Петров Б."}' person create >/dev/null
a=$(run '{"reference":"Петров"}' person resolve); contains "$a" '"count":2'; contains "$a" '"ambiguous":true'
run '{"operation_key":"l2","display_name":"СД duplicate"}' label create >/dev/null
run '{"operation_key":"tl2","task_id":"T-1","label_id":"L-2"}' task-label add >/dev/null
run '{"operation_key":"lm","from_id":"L-2","into_id":"L-1"}' label merge >/dev/null
a=$(run '{"reference":"СД duplicate"}' label resolve); contains "$a" '"display_name":"Совет директоров"'
a=$(run '{"id":"T-1"}' task detail); contains "$a" '"labels":[{"id":"L-1"'

# Atomic failure leaves the Inbox item and all entity/task state unchanged.
run '{"operation_key":"atomic-cap","capture_key":"tg:atomic","content":"atomic"}' inbox add >/dev/null
expect_fail '{"operation_key":"atomic-commit","id":"I-3","tasks":[{"title":"would roll back","assignee":"Дубровин М."},{"title":"invalid"}]}' inbox commit INVALID_FIELD
a=$(run '{"id":"I-3"}' inbox get); contains "$a" '"content":"atomic"'
a=$(run '{"search":"would roll back","status":"*"}' task search); contains "$a" '"count":0'

# Pinned Moscow clock proves today/overdue and invalid deadline boundaries.
expect_fail '{"operation_key":"bad-time","title":"bad","assignee":"Дубровин М.","due_time":"10:00"}' task create INVALID_DEADLINE
run_at '2026-08-21T06:00:00Z' '{"operation_key":"clock","title":"Clock","assignee":"Дубровин М.","due_date":"2026-08-21","due_time":"10:00"}' task create >/dev/null
a=$(run_at '2026-08-21T06:00:00Z' '{"view":"today"}' task list); contains "$a" '"title":"Clock"'
a=$(run_at '2026-08-21T06:00:00Z' '{"view":"overdue"}' task list); [[ "$a" != *'"title":"Clock"'* ]]
a=$(run_at '2026-08-21T08:00:00Z' '{"view":"overdue"}' task list); contains "$a" '"title":"Clock"'
run '{"operation_key":"reason-null","id":"T-3","due_time":"11:00","reason":null}' task update >/dev/null
a=$(run '{"id":"T-3"}' task history); contains "$a" '"event_type":"DUE_TIME_CHANGED"'; contains "$a" '"reason":null'

# Idempotency and conflicting replay.
a=$(run '{"operation_key":"cm2","task_id":"T-1","content":"Минфин обещал ответ завтра"}' comment add); contains "$a" '"idempotent_replay":true'
expect_fail '{"operation_key":"cm2","task_id":"T-1","content":"different"}' comment add IDEMPOTENCY_KEY_REUSE

# Historical schema generations are no longer executable migration inputs.
LEGACY="$TMP/legacy.sqlite3"
node - "$LEGACY" <<'JS'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA user_version=2;');db.close();
JS
set +e
legacy_out=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$LEGACY" node "$TASKCTL" health 2>&1)
legacy_rc=$?
set -e
[ "$legacy_rc" -ne 0 ] || { echo "legacy schema unexpectedly migrated" >&2; exit 1; }
contains "$legacy_out" 'UNSUPPORTED_SCHEMA'

a=$(plain health); contains "$a" '"schema_version":8'
node - "$DB" <<'JS'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});if(db.prepare('pragma integrity_check').get().integrity_check!=='ok'||db.prepare('pragma foreign_key_check').all().length)process.exit(1);db.close();
JS
printf 'BATCH1_CORE_DETERMINISTIC_PASS\n'
