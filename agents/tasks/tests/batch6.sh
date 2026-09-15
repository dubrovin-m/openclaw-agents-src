#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASKCTL=${1:-$ROOT/taskctl}
RELEASE_TASKCTL_VERSION=$(node -e 'const r=require(process.argv[1]);process.stdout.write(r.generation.taskctl_version)' "$ROOT/release.json")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/tasks.sqlite3"
NOW="2026-09-03T07:00:00Z"
run(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$NOW" TASKCTL_PAYLOAD="$1" node "$TASKCTL" "$2" "$3"; }
plain(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_TEST_NOW="$NOW" node "$TASKCTL" "$@"; }
ids(){ node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(x.tasks.map(t=>t.id).join(","))' "$1"; }
contains(){ [[ "$1" == *"$2"* ]] || { echo "missing: $2" >&2; echo "$1" >&2; exit 1; }; }
expect_ids(){ local payload=$1 expected=$2 actual; actual=$(ids "$(run "$payload" task list)"); [ "$actual" = "$expected" ] || { echo "unexpected task order" >&2; echo "expected=$expected" >&2; echo "actual=$actual" >&2; exit 1; }; }

# TA-PRES-015..021: deadline-first sections, deterministic Label clustering,
# multi-Label first-canonical grouping, unlabeled-last behavior, due_time ordering,
# stable replay, and no list-side mutation.
a=$(plain init)
node -e 'const x=JSON.parse(process.argv[1]); if(x.implementation_version!==process.argv[2] || x.schema_version!==6) process.exit(1)' "$a" "$RELEASE_TASKCTL_VERSION"
run '{"operation_key":"la","display_name":"А"}' label create >/dev/null
run '{"operation_key":"lb","display_name":"Б"}' label create >/dev/null

run '{"operation_key":"t1","title":"Future B","assignee":"Дубровин М.","due_date":"2026-09-05","labels":["Б"]}' task create >/dev/null
run '{"operation_key":"t2","title":"Overdue B","assignee":"Дубровин М.","due_date":"2026-09-01","labels":["Б"]}' task create >/dev/null
run '{"operation_key":"t3","title":"Today A","assignee":"Дубровин М.","due_date":"2026-09-03","labels":["А"]}' task create >/dev/null
run '{"operation_key":"t4","title":"Overdue A","assignee":"Дубровин М.","due_date":"2026-09-02","labels":["А"]}' task create >/dev/null
run '{"operation_key":"t5","title":"Tomorrow B","assignee":"Дубровин М.","due_date":"2026-09-04","labels":["Б"]}' task create >/dev/null
run '{"operation_key":"t6","title":"Undated B","assignee":"Дубровин М.","labels":["Б"]}' task create >/dev/null
run '{"operation_key":"t7","title":"Future A","assignee":"Дубровин М.","due_date":"2026-09-05","labels":["А"]}' task create >/dev/null
run '{"operation_key":"t8","title":"Undated unlabeled","assignee":"Дубровин М."}' task create >/dev/null
run '{"operation_key":"t9","title":"Timed overdue B","assignee":"Дубровин М.","due_date":"2026-09-03","due_time":"09:00","labels":["Б"]}' task create >/dev/null
run '{"operation_key":"t10","title":"Timed today B","assignee":"Дубровин М.","due_date":"2026-09-03","due_time":"11:00","labels":["Б"]}' task create >/dev/null
run '{"operation_key":"t11","title":"Tomorrow A","assignee":"Дубровин М.","due_date":"2026-09-04","labels":["А"]}' task create >/dev/null
run '{"operation_key":"t12","title":"Tomorrow B second","assignee":"Дубровин М.","due_date":"2026-09-04","labels":["Б"]}' task create >/dev/null
run '{"operation_key":"t13","title":"Tomorrow multi label","assignee":"Дубровин М.","due_date":"2026-09-04","labels":["Б","А"]}' task create >/dev/null
run '{"operation_key":"t14","title":"Tomorrow unlabeled","assignee":"Дубровин М.","due_date":"2026-09-04"}' task create >/dev/null

before=$(plain health)
expect_ids '{}' 'T-4,T-2,T-9,T-3,T-10,T-11,T-13,T-5,T-12,T-14,T-7,T-1,T-6,T-8'
expect_ids '{}' 'T-4,T-2,T-9,T-3,T-10,T-11,T-13,T-5,T-12,T-14,T-7,T-1,T-6,T-8'
expect_ids '{"view":"today"}' 'T-4,T-2,T-9,T-3,T-10'
expect_ids '{"due_on":"2026-09-03"}' 'T-9,T-3,T-10'
after=$(plain health)
[ "$before" = "$after" ] || { echo "task_list mutated operational state" >&2; exit 1; }

# The multi-label Task groups by the first canonical Label in deterministic Label order.
a=$(run '{"id":"T-13"}' task detail); contains "$a" '"display_name":"А"'; contains "$a" '"display_name":"Б"'

# TA-MUT-001 / TA-PRES-022 / TA-PRES-023 deterministic support: expanded today
# remains complete across assignees and preserves the canonical detailed title exactly.
LONG_TITLE='Подготовить материал: поведение сегментов в кризис и динамика поисковых запросов без сокращений'
run '{"operation_key":"person-other","display_name":"Тестовый Исполнитель"}' person create >/dev/null
run "{\"operation_key\":\"today-other\",\"title\":\"$LONG_TITLE\",\"assignee\":\"Тестовый Исполнитель\",\"due_date\":\"2026-09-03\",\"labels\":[\"А\"]}" task create >/dev/null
a=$(run '{"view":"today"}' task list)
node - "$a" "$LONG_TITLE" <<'NODE'
const x=JSON.parse(process.argv[2]), expectedTitle=process.argv[3];
const ids=x.tasks.map(t=>t.id);
const expected=['T-2','T-3','T-4','T-9','T-10','T-15'];
if(ids.length!==expected.length || expected.some(id=>!ids.includes(id)) || new Set(ids).size!==ids.length) process.exit(1);
const t=x.tasks.find(t=>t.id==='T-15');
if(!t || t.title!==expectedTitle || t.assignee!=='Тестовый Исполнитель' || t.due_date!=='2026-09-03') process.exit(1);
NODE

# TA-LBL-020/021 deterministic backend path remains correct with canonical label_id.
a=$(run '{"reference":"А"}' label resolve); contains "$a" '"id":"L-1"'
run '{"operation_key":"assoc-add","task_id":"T-8","label_id":"L-1"}' task-label add >/dev/null
a=$(run '{"id":"T-8"}' task detail); contains "$a" '"labels":[{"id":"L-1"'
run '{"operation_key":"assoc-remove","task_id":"T-8","label_id":"L-1"}' task-label remove >/dev/null
a=$(run '{"id":"T-8"}' task detail); contains "$a" '"labels":[]'

# TA-FC-001..004/010 deterministic support: direct task.create can reuse canonical
# self/Label state, retain the explicit Moscow-local deadline, omit an absent deadline,
# and replay the same operation idempotently without creating any Inbox item.
fc_payload='{"operation_key":"fc-structured","title":"Fast Create structured","assignee_id":"P-1","due_date":"2026-09-03","labels":[{"id":"L-1"}]}'
a=$(run "$fc_payload" task create); contains "$a" '"ok":true'; contains "$a" '"assignee":"Дубровин М."'; contains "$a" '"due_date":"2026-09-03"'
fc_id=$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(x.task.id)' "$a")
a=$(run "{\"id\":\"$fc_id\"}" task detail); contains "$a" '"labels":[{"id":"L-1"'
before_replay=$(plain health)
a=$(run "$fc_payload" task create); contains "$a" '"idempotent_replay":true'
after_replay=$(plain health); [ "$before_replay" = "$after_replay" ] || { echo "Fast Create support replay mutated state" >&2; exit 1; }
a=$(run '{"operation_key":"fc-no-due","title":"Fast Create no deadline","assignee_id":"P-1"}' task create); contains "$a" '"due_date":null'; contains "$a" '"due_time":null'
a=$(plain health); contains "$a" '"inbox":0'

printf 'BATCH6_OK\n'
