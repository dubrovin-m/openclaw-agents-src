#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASKCTL=${1:-"$ROOT/taskctl"}
EXPECTED_TASKCTL_VERSION=$(node -e 'process.stdout.write(require(process.argv[1]).generation.taskctl_version)' "$ROOT/release.json")
TMP=$(mktemp -d "${TMPDIR:-/tmp}/task-compatibility-window.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM
fail(){ echo "compatibility-window: $*" >&2; exit 1; }

logical_fingerprint(){
  node - "$1" "$2" <<'NODE'
const {createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
function snapshot(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const data={};
    for(const {name} of objects.filter(x=>x.type==='table')){
      const q='"'+String(name).replaceAll('"','""')+'"';
      data[name]=db.prepare(`SELECT * FROM ${q} ORDER BY rowid`).all();
    }
    return {user_version:Number(db.prepare('PRAGMA user_version').get().user_version),integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,fk:db.prepare('PRAGMA foreign_key_check').all(),objects,data};
  } finally { db.close(); }
}
const state={tasks:snapshot(process.argv[2]),contacts:snapshot(process.argv[3])};
process.stdout.write(createHash('sha256').update(JSON.stringify(state)).digest('hex'));
NODE
}

BASE="$TMP/base"
mkdir -p "$BASE"
TASK_DB="$BASE/tasks.sqlite3"
CONTACTS_DB="$BASE/contacts.sqlite3"
fresh=$(HOME="$TMP/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TASK_DB" TASKCTL_CONTACTS_DB="$CONTACTS_DB" "$TASKCTL" init)
node - "$fresh" "$TASK_DB" "$CONTACTS_DB" "$EXPECTED_TASKCTL_VERSION" <<'NODE' || fail "fresh install did not create current schemas"
const {DatabaseSync}=require('node:sqlite'),out=JSON.parse(process.argv[2]),t=new DatabaseSync(process.argv[3],{readOnly:true}),c=new DatabaseSync(process.argv[4],{readOnly:true}),expected=process.argv[5];
try{
  if(out.implementation_version!==expected||out.schema_version!==9)process.exit(1);
  if(Number(t.prepare('PRAGMA user_version').get().user_version)!==9||Number(c.prepare('PRAGMA user_version').get().user_version)!==3)process.exit(2);
  if(t.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('people','person_aliases')").get().n!==0)process.exit(3);
  for(const table of ['projects','recurrences','reminders','task_domain_bindings','deadline_change_requests'])if(!t.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?").get(table))process.exit(4);
  if(t.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||t.prepare('PRAGMA foreign_key_check').all().length!==0||c.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||c.prepare('PRAGMA foreign_key_check').all().length!==0)process.exit(5);
} finally {t.close();c.close();}
NODE

TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TASK_DB" TASKCTL_CONTACTS_DB="$CONTACTS_DB" TASKCTL_PAYLOAD='{"operation_key":"compat-label","display_name":"Compatibility"}' "$TASKCTL" label create >/dev/null
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TASK_DB" TASKCTL_CONTACTS_DB="$CONTACTS_DB" TASKCTL_PAYLOAD='{"operation_key":"compat-task","title":"Compatibility sentinel","assignee":"Дубровин М.","labels":["L-1"]}' "$TASKCTL" task create >/dev/null
before=$(logical_fingerprint "$TASK_DB" "$CONTACTS_DB")
current=$(HOME="$TMP/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$TASK_DB" TASKCTL_CONTACTS_DB="$CONTACTS_DB" "$TASKCTL" init)
node - "$current" "$EXPECTED_TASKCTL_VERSION" <<'NODE' || fail "current schema init did not remain current"
const x=JSON.parse(process.argv[2]);if(x.implementation_version!==process.argv[3]||x.schema_version!==9)process.exit(1);
NODE
after=$(logical_fingerprint "$TASK_DB" "$CONTACTS_DB")
[ "$before" = "$after" ] || fail "current schema init changed logical data"

for schema in 4 5 6 7 8; do
  D="$TMP/schema-$schema"
  mkdir -p "$D"
  cp "$TASK_DB" "$D/tasks.sqlite3"
  cp "$CONTACTS_DB" "$D/contacts.sqlite3"
  node - "$D/tasks.sqlite3" "$schema" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2]);
try{db.exec(`PRAGMA user_version=${Number(process.argv[3])}`);}finally{db.close();}
NODE
  task_before=$(sha256sum "$D/tasks.sqlite3"|awk '{print $1}')
  contacts_before=$(sha256sum "$D/contacts.sqlite3"|awk '{print $1}')
  set +e
  out=$(HOME="$TMP/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$D/tasks.sqlite3" TASKCTL_CONTACTS_DB="$D/contacts.sqlite3" "$TASKCTL" init 2>&1)
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "schema $schema init unexpectedly succeeded"
  [[ "$out" == *'"code":"UNSUPPORTED_SCHEMA"'* ]] || fail "schema $schema did not report UNSUPPORTED_SCHEMA"
  [ "$(sha256sum "$D/tasks.sqlite3"|awk '{print $1}')" = "$task_before" ] || fail "schema $schema Task DB mutated"
  [ "$(sha256sum "$D/contacts.sqlite3"|awk '{print $1}')" = "$contacts_before" ] || fail "schema $schema Contacts DB mutated"
  found=$(node - "$D/tasks.sqlite3" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{process.stdout.write(String(db.prepare('PRAGMA user_version').get().user_version));}finally{db.close();}
NODE
)
  [ "$found" = "$schema" ] || fail "schema $schema user_version changed"
done

printf 'TASK_COMPATIBILITY_WINDOW_PASS\n'
