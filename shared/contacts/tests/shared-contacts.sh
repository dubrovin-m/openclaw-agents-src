#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TASKCTL="$ROOT/agents/tasks/taskctl"
CONTACTCTL="$ROOT/shared/contacts/contactctl"
PREDECESSOR=42329b0edab9d8d3ab9fa16257fc11723cd6acaf
TMP=$(mktemp -d /tmp/shared-contacts.XXXXXX)
trap 'rm -rf "$TMP"' EXIT INT TERM
DB="$TMP/tasks.sqlite3"
CDB="$TMP/contacts.sqlite3"
trun(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_CONTACTS_DB="$CDB" TASKCTL_PAYLOAD="$1" "$TASKCTL" "$2" "$3"; }
crun(){ CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$CDB" CONTACTCTL_PAYLOAD="$1" "$CONTACTCTL" "$2"; }

# Runtime reads fail closed when the shared registry is missing; only explicit init may create it.
MISSING_CDB="$TMP/missing/contacts.sqlite3"
set +e
missing_health=$(CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$MISSING_CDB" CONTACTCTL_PAYLOAD='{}' "$CONTACTCTL" health); missing_health_rc=$?
missing_search=$(CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$MISSING_CDB" CONTACTCTL_PAYLOAD='{"query":"Дубровин"}' "$CONTACTCTL" search); missing_search_rc=$?
set -e
[ "$missing_health_rc" -eq 3 ] && [ "$missing_search_rc" -eq 3 ]
[ ! -e "$MISSING_CDB" ]
node -e 'for(const raw of process.argv.slice(1)){const x=JSON.parse(raw);if(x?.error?.code!=="CONTACTS_DB_MISSING")process.exit(1)}' "$missing_health" "$missing_search"
CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$MISSING_CDB" "$CONTACTCTL" init >/dev/null
[ -f "$MISSING_CDB" ]
rm -rf "$TMP/missing"

# An established current Task store must not silently recreate a lost Contacts registry.
LOST_TDB="$TMP/lost/tasks.sqlite3"; LOST_CDB="$TMP/lost/contacts.sqlite3"; mkdir -p "$TMP/lost"
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$LOST_TDB" TASKCTL_CONTACTS_DB="$LOST_CDB" "$TASKCTL" init >/dev/null
rm -f "$LOST_CDB" "$LOST_CDB-journal"
set +e
lost_health=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$LOST_TDB" TASKCTL_CONTACTS_DB="$LOST_CDB" "$TASKCTL" health); lost_health_rc=$?
set -e
[ "$lost_health_rc" -ne 0 ]
[ ! -e "$LOST_CDB" ]
rm -rf "$TMP/lost"
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_CONTACTS_DB="$CDB" "$TASKCTL" init | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.schema_version!==9||x.implementation_version!=="0.4.12")process.exit(1)})'
CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$CDB" "$CONTACTCTL" init | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.schema_version!==3||x.implementation_version!=="0.1.4")process.exit(1)})'
# Explicit Contact identity plus Task reuse.
crun '{"operation_key":"c1","display_name":"Побединская Н.","organization":"Компания","title":"Директор"}' create >/dev/null
trun '{"reference":"Побединская"}' person resolve | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.outcome!=="MATCH"||x.matches[0].id!=="P-2")process.exit(1)})'
trun '{"operation_key":"t1","title":"Shared identity","assignee":"Побединская"}' task create >/dev/null

# Alias collisions are persisted and fail closed at resolution.
crun '{"operation_key":"c2","display_name":"Иванов А."}' create >/dev/null
crun '{"operation_key":"c3","display_name":"Петров Б."}' create >/dev/null
crun '{"operation_key":"a1","id":"P-3","alias":"Саша"}' alias_add >/dev/null
crun '{"operation_key":"a2","id":"P-4","alias":"Саша"}' alias_add >/dev/null
crun '{"reference":"Саша"}' resolve | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.outcome!=="AMBIGUOUS"||x.matches.length!==2)process.exit(1)})'

# Cross-store mutation rollback removes both the Task and newly created Person.
set +e
rollback=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_CONTACTS_DB="$CDB" TASKCTL_PAYLOAD='{"operation_key":"rollback","title":"Rollback","assignee":"Новый Человек","create_assignee":true,"labels":["Missing label"]}' "$TASKCTL" task create)
rc=$?
set -e
[ "$rc" -ne 0 ]
node - "$DB" "$CDB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const t=new DatabaseSync(process.argv[2],{readOnly:true}),c=new DatabaseSync(process.argv[3],{readOnly:true});
if(t.prepare("select count(*) n from tasks where title='Rollback'").get().n!==0)process.exit(1);
if(c.prepare("select count(*) n from people where display_name='Новый Человек'").get().n!==0)process.exit(2);t.close();c.close();
NODE
# Merge preserves stored historical Task reference while reads follow canonical redirect.
crun '{"operation_key":"c4","display_name":"Побединская Наталья"}' create >/dev/null
crun '{"operation_key":"m1","from_id":"P-2","into_id":"P-5"}' merge >/dev/null
trun '{"id":"T-1"}' task get | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.task.assignee_id!=="P-5"||x.task.assignee!=="Побединская Наталья")process.exit(1)})'
node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});if(db.prepare('select assignee_id from tasks where id=1').get().assignee_id!==2)process.exit(1);db.close();
NODE

# A later merge rewires earlier redirects directly to the new ACTIVE target.
crun '{"operation_key":"c5","display_name":"Побединская Н.В."}' create >/dev/null
crun '{"operation_key":"m2","from_id":"P-5","into_id":"P-6"}' merge >/dev/null
node - "$CDB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});const rows=db.prepare('select id,status,merged_into from people where id in (2,5,6) order by id').all();if(rows[0].merged_into!==6||rows[1].merged_into!==6||rows[2].status!=='ACTIVE')process.exit(1);db.close();
NODE
trun '{"id":"T-1"}' task get | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.task.assignee_id!=="P-6")process.exit(1)})'
# Historical schema-6 Task state migrates losslessly through Shared Contacts to the current Task schema.
PRE="$TMP/predecessor-taskctl"; git -C "$ROOT" show "$PREDECESSOR:agents/tasks/taskctl" > "$PRE"; chmod 700 "$PRE"
MDB="$TMP/migrate/tasks.sqlite3"; MCDB="$TMP/migrate/contacts.sqlite3"; mkdir -p "$TMP/migrate"
oldrun(){ TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$MDB" TASKCTL_TEST_NOW=2026-09-16T09:00:00Z TASKCTL_PAYLOAD="$1" "$PRE" "$2" "$3"; }
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$MDB" TASKCTL_TEST_NOW=2026-09-16T09:00:00Z "$PRE" init >/dev/null
oldrun '{"operation_key":"p","display_name":"Иванов И."}' person create >/dev/null
oldrun '{"operation_key":"a","id":"P-2","alias":"Иванов"}' person alias_add >/dev/null
oldrun '{"operation_key":"t","title":"Predecessor task","assignee":"Иванов"}' task create >/dev/null
oldrun '{"operation_key":"r","mode":"AFTER_COMPLETION","rule":{"interval":7,"unit":"DAYS"},"title":"Predecessor recurrence","assignee_id":"P-2","first_due_date":"2026-09-20"}' recurrence create >/dev/null
node - "$MDB" > "$TMP/before.json" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});const out={people:d.prepare('select id,display_name,created_at from people order by id').all(),aliases:d.prepare('select person_id,alias from person_aliases order by person_id,alias').all(),tasks:d.prepare('select id,assignee_id from tasks order by id').all(),recurrences:d.prepare('select id,assignee_id from recurrences order by id').all()};process.stdout.write(JSON.stringify(out));d.close();
NODE
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$MDB" TASKCTL_CONTACTS_DB="$MCDB" "$TASKCTL" health >/dev/null
node - "$MDB" "$MCDB" "$TMP/before.json" <<'NODE'
const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');const before=JSON.parse(fs.readFileSync(process.argv[4]));const t=new DatabaseSync(process.argv[2],{readOnly:true}),c=new DatabaseSync(process.argv[3],{readOnly:true});const after={people:c.prepare('select id,display_name,created_at from people order by id').all(),aliases:c.prepare('select person_id,alias from person_aliases order by person_id,alias').all(),tasks:t.prepare('select id,assignee_id from tasks order by id').all(),recurrences:t.prepare('select id,assignee_id from recurrences order by id').all()};if(t.prepare('pragma user_version').get().user_version!==9||c.prepare('pragma user_version').get().user_version!==3)process.exit(1);if(JSON.stringify(before)!==JSON.stringify(after))process.exit(2);if(t.prepare("select count(*) n from sqlite_master where type='table' and name in ('people','person_aliases')").get().n!==0)process.exit(3);if(c.prepare("select count(*) n from people where is_self=1 and status='ACTIVE'").get().n!==1)process.exit(4);if(t.prepare('pragma foreign_key_check').all().length||c.prepare('pragma foreign_key_check').all().length)process.exit(5);t.close();c.close();
NODE

# Preparation-owned migration failure restores schema 6 and removes a newly-created Contacts file.
FDB="$TMP/fault/tasks.sqlite3"; FCDB="$TMP/fault/contacts.sqlite3"; mkdir -p "$TMP/fault"
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$FDB" "$PRE" init >/dev/null
set +e
fault=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$FDB" TASKCTL_CONTACTS_DB="$FCDB" TASKCTL_TEST_CONTACTS_MIGRATION_FAULT=after-contacts-copy "$TASKCTL" health); frc=$?
set -e
[ "$frc" -ne 0 ]
[ ! -e "$FCDB" ]
node - "$FDB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[2],{readOnly:true});if(d.prepare('pragma user_version').get().user_version!==6)process.exit(1);if(d.prepare("select count(*) n from sqlite_master where type='table' and name='people'").get().n!==1)process.exit(2);if(d.prepare('pragma integrity_check').get().integrity_check!=='ok'||d.prepare('pragma foreign_key_check').all().length)process.exit(3);d.close();
NODE


# Person Groups have stable identity, reusable membership, and canonical Person merge semantics.
crun '{"operation_key":"pg1","display_name":"Office CEO"}' group_create | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.group.id!=="PG-1"||x.group.members.length!==0)process.exit(1)})'
crun '{"operation_key":"pgm1","group_id":"PG-1","person":"Побединская Н.В."}' group_member_add >/dev/null
crun '{"operation_key":"pgm2","group_id":"PG-1","person":"Побединская Н.В."}' group_member_add | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.changed!==false||x.group.members.length!==1||x.group.members[0].id!=="P-6")process.exit(1)})'
crun '{"operation_key":"pg2","id":"PG-1","display_name":"Executive Office"}' group_rename | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.group.id!=="PG-1"||x.group.display_name!=="Executive Office")process.exit(1)})'
crun '{"id":"PG-1"}' group_get | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.group.id!=="PG-1"||x.group.members.length!==1||x.group.members[0].id!=="P-6")process.exit(1)})'
crun '{"operation_key":"c7","display_name":"Побединская Каноническая"}' create >/dev/null
crun '{"operation_key":"m3","from_id":"P-6","into_id":"P-7"}' merge >/dev/null
crun '{"id":"PG-1"}' group_get | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.group.members.length!==1||x.group.members[0].id!=="P-7")process.exit(1)})'
crun '{"operation_key":"pgr1","group_id":"PG-1","person":"Побединская Каноническая"}' group_member_remove | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.changed!==true||x.group.members.length!==0)process.exit(1)})'

[ "$(stat -c %a "$CDB")" = 600 ]
[ "$(stat -c %a "$(dirname "$CDB")")" = 700 ]
printf 'SHARED_CONTACTS_PASS\n'
