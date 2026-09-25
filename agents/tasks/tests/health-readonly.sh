#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASKCTL=${1:-"$ROOT/taskctl"}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/task-health-readonly.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

fail(){ echo "health-readonly: $*" >&2; exit 1; }
run_health(){
  local db=$1 contacts=$2
  HOME="$TMP/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$db" TASKCTL_CONTACTS_DB="$contacts" "$TASKCTL" health
}
state(){
  local dir=$1
  find "$dir" -maxdepth 1 -type f -printf '%f %m %s %Y %Z\n' 2>/dev/null | sort
  find "$dir" -maxdepth 1 -type f -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum
}

MISSING_DIR="$TMP/missing"
MISSING_DB="$MISSING_DIR/tasks.sqlite3"
MISSING_CONTACTS="$MISSING_DIR/contacts.sqlite3"
set +e
missing_out=$(run_health "$MISSING_DB" "$MISSING_CONTACTS" 2>&1)
missing_rc=$?
set -e
[ "$missing_rc" -ne 0 ] || fail "missing database health unexpectedly succeeded"
[[ "$missing_out" == *'"code":"DATABASE_NOT_FOUND"'* ]] || fail "missing database diagnostic is not explicit"
[ ! -e "$MISSING_DB" ] || fail "health created missing Task database"
[ ! -e "$MISSING_CONTACTS" ] || fail "health created missing Contacts database"
[ ! -e "$MISSING_DIR" ] || fail "health created missing database directory"

CURRENT_DIR="$TMP/current"
CURRENT_DB="$CURRENT_DIR/tasks.sqlite3"
CURRENT_CONTACTS="$CURRENT_DIR/contacts.sqlite3"
mkdir -p "$CURRENT_DIR"
HOME="$TMP/home" TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$CURRENT_DB" TASKCTL_CONTACTS_DB="$CURRENT_CONTACTS" "$TASKCTL" init >/dev/null
before_current=$(state "$CURRENT_DIR")
health=$(run_health "$CURRENT_DB" "$CURRENT_CONTACTS")
node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||x.schema_version!==9||x.contacts_schema_version!==3||x.integrity?.ok!==true)process.exit(1)' "$health" || fail "current-schema health result invalid"
after_current=$(state "$CURRENT_DIR")
[ "$before_current" = "$after_current" ] || fail "health mutated current database files"

OLD_DIR="$TMP/old"
OLD_DB="$OLD_DIR/tasks.sqlite3"
OLD_CONTACTS="$OLD_DIR/contacts.sqlite3"
mkdir -p "$OLD_DIR"
cp "$CURRENT_DB" "$OLD_DB"
cp "$CURRENT_CONTACTS" "$OLD_CONTACTS"
node - "$OLD_DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2]);
try{db.exec('PRAGMA user_version=8;');}finally{db.close();}
NODE
before_old=$(state "$OLD_DIR")
set +e
old_out=$(run_health "$OLD_DB" "$OLD_CONTACTS" 2>&1)
old_rc=$?
set -e
[ "$old_rc" -ne 0 ] || fail "old-schema health unexpectedly succeeded"
[[ "$old_out" == *'"code":"UNSUPPORTED_SCHEMA"'* ]] || fail "old schema diagnostic is not explicit"

after_old=$(state "$OLD_DIR")
[ "$before_old" = "$after_old" ] || fail "health mutated old-schema database files"
old_version=$(node - "$OLD_DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{process.stdout.write(String(db.prepare('PRAGMA user_version').get().user_version));}finally{db.close();}
NODE
)
[ "$old_version" = 8 ] || fail "health migrated old schema"

printf 'TASK_HEALTH_READONLY_PASS\n'
