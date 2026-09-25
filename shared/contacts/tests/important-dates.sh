#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
CONTACTCTL="$ROOT/shared/contacts/contactctl"
TMP=$(mktemp -d /tmp/important-dates.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
DB="$TMP/contacts.sqlite3"
run(){ CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$DB" CONTACTCTL_PAYLOAD="$1" "$CONTACTCTL" "$2"; }
fail_action(){ local payload=$1 action=$2 code=$3 out rc; set +e; out=$(run "$payload" "$action"); rc=$?; set -e; [ "$rc" -ne 0 ]; node -e 'const x=JSON.parse(process.argv[1]);if(x?.error?.code!==process.argv[2])process.exit(1)' "$out" "$code"; }

CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$DB" "$CONTACTCTL" init | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.schema_version!==3||x.implementation_version!=="0.1.5")process.exit(1)})'
run '{"operation_key":"p1","display_name":"Иванов И."}' create >/dev/null

# Birthday creation requires an explicit reminders array; zero means intentionally no reminder.
fail_action '{"operation_key":"missing-policy","person":"Иванов","type":"BIRTHDAY","month":11,"day":18}' date_create INVALID_FIELD
a=$(run '{"operation_key":"d1","person":"Иванов","type":"BIRTHDAY","month":11,"day":18,"reminders":[{"offset_value":2,"offset_unit":"MONTHS"},{"offset_value":0,"offset_unit":"DAYS"}]}' date_create)
node -e 'const x=JSON.parse(process.argv[1]);if(x.date.id!=="DATE-1"||x.date.year!==null||x.date.reminders.length!==2||!x.date.reminders.some(r=>r.offset_value===2&&r.offset_unit==="MONTHS")||!x.date.reminders.some(r=>r.offset_value===0&&r.offset_unit==="DAYS"))process.exit(1)' "$a"

# Only one birthday per Person.
fail_action '{"operation_key":"ddup","person":"Иванов","type":"BIRTHDAY","month":1,"day":2,"reminders":[]}' date_create IMPORTANT_DATE_CONFLICT

# An explicit no-reminder date is valid and remains queryable.
run '{"operation_key":"d2","person":"Иванов","type":"OTHER","year":2026,"month":12,"day":31,"annual":false,"reminders":[]}' date_create >/dev/null
a=$(run '{"person":"Иванов"}' date_list)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==2||x.dates.find(d=>d.id==="DATE-2").reminders.length!==0)process.exit(1)' "$a"

# Calendar arithmetic: month offsets are calendar months; leap-day annual occurrence clamps to month end.
node - "$ROOT/shared/contacts/core.cjs" <<'NODE'
const c=require(process.argv[2]);
if(c.subtractOffset('2027-03-31',1,'MONTHS')!=='2027-02-28')process.exit(1);
if(c.subtractOffset('2028-03-31',1,'MONTHS')!=='2028-02-29')process.exit(2);
NODE
run '{"operation_key":"p2","display_name":"Петров П."}' create >/dev/null
run '{"operation_key":"leap","person":"Петров","type":"BIRTHDAY","month":2,"day":29,"reminders":[]}' date_create >/dev/null
a=$(run '{"from_date":"2027-02-01","horizon_days":27,"person":"Петров"}' date_upcoming)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||x.dates[0].occurrence_date!=="2027-02-28"||x.dates[0].days_until!==27)process.exit(1)' "$a"

# Reminder-policy replacement preserves unchanged reminder identity and removes obsolete state.
before=$(run '{"person":"Иванов","type":"BIRTHDAY"}' date_list)
keep=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.dates[0].reminders.find(r=>r.offset_value===2&&r.offset_unit==="MONTHS").id)' "$before")
a=$(run '{"operation_key":"policy","id":"DATE-1","reminders":[{"offset_value":2,"offset_unit":"MONTHS"},{"offset_value":1,"offset_unit":"WEEKS"}]}' date_reminders_set)
node -e 'const x=JSON.parse(process.argv[1]),keep=process.argv[2];if(x.date.reminders.length!==2||!x.date.reminders.some(r=>r.id===keep)||!x.date.reminders.some(r=>r.offset_value===1&&r.offset_unit==="WEEKS")||x.date.reminders.some(r=>r.offset_value===0))process.exit(1)' "$a" "$keep"

# 2 calendar months before 18 Nov is due on 18 Sep; dispatch is claim/retry safe and settles only after confirmed delivery.
a=$(run '{"claim_token":"job:1","boundary":"2026-09-18T06:00:00.000Z"}' date_dispatch)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||x.items[0].occurrence_date!=="2026-11-18"||x.items[0].days_until!==61||!x.message.includes("Иванов И."))process.exit(1)' "$a"
a=$(run '{"claim_token":"job:1"}' date_render)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||!x.message.includes("за 2 месяца"))process.exit(1)' "$a"
a=$(run '{"claim_token":"job:1","delivered":true}' date_settle)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||x.delivered!==true)process.exit(1)' "$a"
a=$(run '{"claim_token":"job:2","boundary":"2026-09-18T06:01:00.000Z"}' date_dispatch)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==0)process.exit(1)' "$a"

# Annual reminders may reach beyond the next occurrence. Pick the latest triggered
# future occurrence rather than replaying stale nearer-year occurrences.
run '{"operation_key":"long-annual","person":"Петров","type":"OTHER","month":9,"day":18,"annual":true,"reminders":[{"offset_value":24,"offset_unit":"MONTHS"}]}' date_create >/dev/null
a=$(run '{"claim_token":"job:long","boundary":"2026-09-18T06:05:00.000Z"}' date_dispatch)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||x.items[0].occurrence_date!=="2028-09-18"||x.items[0].offset_value!==24||x.items[0].offset_unit!=="MONTHS")process.exit(1)' "$a"
run '{"claim_token":"job:long","delivered":true}' date_settle >/dev/null

# Expired one-shot dates are discarded before offset arithmetic, including the
# lower supported year boundary where subtracting a reminder offset would underflow.
run '{"operation_key":"expired-boundary","person":"Петров","type":"OTHER","year":1000,"month":1,"day":15,"annual":false,"reminders":[{"offset_value":1,"offset_unit":"MONTHS"}]}' date_create >/dev/null

# Failed delivery releases the claim and permits deterministic retry.
run '{"operation_key":"d3","person":"Петров","type":"OTHER","year":2026,"month":10,"day":18,"annual":false,"reminders":[{"offset_value":1,"offset_unit":"MONTHS"}]}' date_create >/dev/null
a=$(run '{"claim_token":"job:3","boundary":"2026-09-18T07:00:00.000Z"}' date_dispatch)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1)process.exit(1)' "$a"
run '{"claim_token":"job:3","delivered":false}' date_settle >/dev/null
a=$(run '{"claim_token":"job:4","boundary":"2026-09-18T07:01:00.000Z"}' date_dispatch)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1)process.exit(1)' "$a"
run '{"claim_token":"job:4","delivered":true}' date_settle >/dev/null

# Catch-up: a missed trigger remains due until the occurrence itself passes.
run '{"operation_key":"d4","person":"Петров","type":"OTHER","year":2026,"month":12,"day":31,"annual":false,"reminders":[{"offset_value":4,"offset_unit":"MONTHS"}]}' date_create >/dev/null
a=$(run '{"claim_token":"job:5","boundary":"2026-09-18T08:00:00.000Z"}' date_dispatch)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||x.items[0].occurrence_date!=="2026-12-31")process.exit(1)' "$a"
run '{"claim_token":"job:5","delivered":true}' date_settle >/dev/null

# Idempotent date mutation.
a=$(run '{"operation_key":"policy","id":"DATE-1","reminders":[{"offset_value":2,"offset_unit":"MONTHS"},{"offset_value":1,"offset_unit":"WEEKS"}]}' date_reminders_set)
node -e 'const x=JSON.parse(process.argv[1]);if(x.idempotent_replay!==true)process.exit(1)' "$a"

# Person merge transfers Person-owned dates; conflicting birthdays fail closed.
run '{"operation_key":"p3","display_name":"Источник И."}' create >/dev/null
run '{"operation_key":"p4","display_name":"Цель Ц."}' create >/dev/null
run '{"operation_key":"merge-date","person":"Источник","type":"BIRTHDAY","month":5,"day":20,"reminders":[{"offset_value":1,"offset_unit":"MONTHS"}]}' date_create >/dev/null
run '{"operation_key":"merge-ok","from_id":"P-4","into_id":"P-5"}' merge >/dev/null
a=$(run '{"person":"Цель","type":"BIRTHDAY"}' date_list)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||x.dates[0].person.id!=="P-5"||x.dates[0].reminders.length!==1)process.exit(1)' "$a"
run '{"operation_key":"p5","display_name":"Конфликт А."}' create >/dev/null
run '{"operation_key":"p6","display_name":"Конфликт Б."}' create >/dev/null
run '{"operation_key":"conflict-a","person":"P-6","type":"BIRTHDAY","month":1,"day":10,"reminders":[]}' date_create >/dev/null
run '{"operation_key":"conflict-b","person":"P-7","type":"BIRTHDAY","month":2,"day":10,"reminders":[]}' date_create >/dev/null
fail_action '{"operation_key":"merge-conflict","from_id":"P-6","into_id":"P-7"}' merge IMPORTANT_DATE_CONFLICT
a=$(run '{"person":"P-6","type":"BIRTHDAY"}' date_list)
node -e 'const x=JSON.parse(process.argv[1]);if(x.count!==1||x.dates[0].person.id!=="P-6")process.exit(1)' "$a"

# Historical Contacts schemas are unsupported and must remain byte-for-byte unchanged.
for schema in 1 2; do
  OLDDB="$TMP/unsupported-$schema.sqlite3"
  cp "$DB" "$OLDDB"
  node - "$OLDDB" "$schema" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2]);db.exec(`pragma user_version=${Number(process.argv[3])}`);db.close();
NODE
  BEFORE=$(sha256sum "$OLDDB" | awk '{print $1}')
  set +e
  OUT=$(CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$OLDDB" "$CONTACTCTL" init)
  RC=$?
  set -e
  [ "$RC" -ne 0 ]
  node -e 'const x=JSON.parse(process.argv[1]),schema=process.argv[2];if(x?.error?.code!=="INTERNAL_ERROR"||!String(x?.error?.message||"").includes("Unsupported Contacts schema version "+schema))process.exit(1)' "$OUT" "$schema"
  [ "$(sha256sum "$OLDDB" | awk '{print $1}')" = "$BEFORE" ]
done

[ "$(stat -c %a "$DB")" = 600 ]
printf 'IMPORTANT_DATES_PASS\n'
