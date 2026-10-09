#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d /tmp/contacts-independent-backup-test.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/home" "$TEST_ROOT/uploads"

cat > "$TEST_ROOT/bin/age" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
out=""; input=""
while (($#)); do
  case "$1" in -r|-i) shift 2 ;; -d) shift ;; -o) out=$2; shift 2 ;; *) input=$1; shift ;; esac
done
cp "$input" "$out"
SH
cat > "$TEST_ROOT/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$TEST_CURL_LOG"; printf '\n' >> "$TEST_CURL_LOG"
file=""; url=""
while (($#)); do
  case "$1" in
    --config) shift 2 ;;
    --upload-file) file=$2; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
[[ -n "$file" && -n "$url" ]]
cp "$file" "$TEST_UPLOADS/${url##*/}"
SH
chmod +x "$TEST_ROOT/bin/age" "$TEST_ROOT/bin/curl"
printf '%s\n' 'synthetic-secret-token' > "$TEST_ROOT/token"
chmod 600 "$TEST_ROOT/token"

create_db() {
  local path=$1 bad_fk=$2
  BAD_FK="$bad_fk" node - "$path" <<'NODE'
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
try {
  db.exec('PRAGMA user_version=5; PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1);');
  db.exec(process.env.BAD_FK === '1' ? 'INSERT INTO child VALUES(1,999);' : 'INSERT INTO child VALUES(1,1);');
} finally { db.close(); }
NODE
}

run_backup() {
  local db=$1 home=$2 uploads=$3 log=$4
  PATH="$TEST_ROOT/bin:$PATH" HOME="$home" XDG_STATE_HOME="$home/state" TEST_UPLOADS="$uploads" TEST_CURL_LOG="$log" \
    CONTACTS_DB="$db" GITLAB_PROJECT_ID=123 \
    GITLAB_DEPLOY_TOKEN_FILE="$TEST_ROOT/token" AGE_RECIPIENT=age1syntheticrecipient \
    bash "$ROOT/backup.sh"
}

GOOD_DB="$TEST_ROOT/good.sqlite3"
create_db "$GOOD_DB" 0
run_backup "$GOOD_DB" "$TEST_ROOT/home" "$TEST_ROOT/uploads" "$TEST_ROOT/curl.log" >/dev/null
version=$(node -e 'const s=require(process.argv[1]);if(s.last_result!=="PASS"||s.sqlite_schema!==5)process.exit(1);process.stdout.write(s.last_success_package_version)' "$TEST_ROOT/home/state/nexus-recovery/contacts-independent-backup.json")
[[ -n "$version" ]]
[[ -s "$TEST_ROOT/uploads/contactss.sqlite3.age" && -s "$TEST_ROOT/uploads/manifest.json" ]]
node -e 'const m=require(process.argv[1]);if(m.class!=="contacts-sqlite"||m.validation.sqlite_schema!==5||m.validation.integrity_check!=="ok"||m.validation.foreign_key_violations!==0)process.exit(1)' "$TEST_ROOT/uploads/manifest.json"
! grep -q 'synthetic-secret-token' "$TEST_ROOT/curl.log"
[[ $(find /tmp -maxdepth 1 -name 'nexus-contacts-recovery.*' | wc -l) -eq 0 ]]

BAD_DB="$TEST_ROOT/bad.sqlite3"
create_db "$BAD_DB" 1
mkdir -p "$TEST_ROOT/bad-home" "$TEST_ROOT/bad-uploads"
set +e
run_backup "$BAD_DB" "$TEST_ROOT/bad-home" "$TEST_ROOT/bad-uploads" "$TEST_ROOT/bad-curl.log" >/dev/null 2>&1
code=$?
set -e
[[ $code -ne 0 ]]
[[ $(find "$TEST_ROOT/bad-uploads" -type f | wc -l) -eq 0 ]]
node -e 'const s=require(process.argv[1]);if(s.last_result!=="FAIL"||s.last_success_at)process.exit(1)' "$TEST_ROOT/bad-home/state/nexus-recovery/contacts-independent-backup.json"
[[ $(find /tmp -maxdepth 1 -name 'nexus-contacts-recovery.*' | wc -l) -eq 0 ]]

SERVICE="$ROOT/contacts-independent-backup.service"
grep -Fxq 'NoNewPrivileges=true' "$SERVICE"
grep -Fxq 'PrivateTmp=true' "$SERVICE"
grep -Fxq 'ProtectSystem=full' "$SERVICE"
grep -Fxq 'ProtectControlGroups=true' "$SERVICE"
grep -Fxq 'ProtectKernelTunables=true' "$SERVICE"
! grep -Fxq 'ProtectKernelModules=true' "$SERVICE"


# Verify an isolated restore, including rejection of tampered ciphertext.
printf '%s\n' 'AGE-SECRET-KEY-1SYNTHETIC' > "$TEST_ROOT/identity"
chmod 600 "$TEST_ROOT/identity"
RESTORED="$TEST_ROOT/isolated/contacts.sqlite3"
PATH="$TEST_ROOT/bin:$PATH" bash "$ROOT/restore.sh" \
  --ciphertext "$TEST_ROOT/uploads/contacts.sqlite3.age" \
  --manifest "$TEST_ROOT/uploads/manifest.json" \
  --identity "$TEST_ROOT/identity" \
  --output "$RESTORED" --apply >/dev/null
node - "$RESTORED" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try {
  if(db.prepare('PRAGMA user_version').get().user_version!==5)process.exit(1);
  if(db.prepare('SELECT count(*) n FROM child').get().n!==1)process.exit(1);
} finally { db.close(); }
NODE
[[ $(stat -c %a "$RESTORED") == 600 ]]
printf '%s' 'tamper' >> "$TEST_ROOT/uploads/contacts.sqlite3.age"
set +e
PATH="$TEST_ROOT/bin:$PATH" bash "$ROOT/restore.sh" \
  --ciphertext "$TEST_ROOT/uploads/contacts.sqlite3.age" \
  --manifest "$TEST_ROOT/uploads/manifest.json" \
  --identity "$TEST_ROOT/identity" \
  --output "$TEST_ROOT/isolated/tampered.sqlite3" --apply >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 && ! -e "$TEST_ROOT/isolated/tampered.sqlite3" ]]

# Exercise the actual Contacts schema, not only a generic SQLite fixture.
REAL_DB="$TEST_ROOT/real-contacts.sqlite3"
CONTACTCTL="$ROOT/../../contactctl"
CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$REAL_DB" "$CONTACTCTL" init >/dev/null
CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$REAL_DB" CONTACTCTL_PAYLOAD='{"operation_key":"test-create","display_name":"Synthetic Person"}' "$CONTACTCTL" create >/dev/null
CONTACTCTL_ALLOW_DB_OVERRIDE=1 CONTACTCTL_DB="$REAL_DB" CONTACTCTL_PAYLOAD='{"operation_key":"test-group","display_name":"Synthetic Group"}' "$CONTACTCTL" group_create >/dev/null
mkdir -p "$TEST_ROOT/real-home" "$TEST_ROOT/real-uploads"
run_backup "$REAL_DB" "$TEST_ROOT/real-home" "$TEST_ROOT/real-uploads" "$TEST_ROOT/real-curl.log" >/dev/null
REAL_RESTORED="$TEST_ROOT/isolated/real-contacts.sqlite3"
PATH="$TEST_ROOT/bin:$PATH" bash "$ROOT/restore.sh" \
  --ciphertext "$TEST_ROOT/real-uploads/contacts.sqlite3.age" \
  --manifest "$TEST_ROOT/real-uploads/manifest.json" \
  --identity "$TEST_ROOT/identity" \
  --output "$REAL_RESTORED" --apply >/dev/null
node - "$REAL_DB" "$REAL_RESTORED" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const source=new DatabaseSync(process.argv[2],{readOnly:true});
const restored=new DatabaseSync(process.argv[3],{readOnly:true});
try {
  for(const sql of ['PRAGMA user_version','SELECT count(*) n FROM people','SELECT count(*) n FROM person_groups']){
    const s=source.prepare(sql).get(),r=restored.prepare(sql).get();
    if(JSON.stringify(s)!==JSON.stringify(r)) process.exit(1);
  }
  if(restored.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')process.exit(1);
  if(restored.prepare('PRAGMA foreign_key_check').all().length!==0)process.exit(1);
}finally{source.close();restored.close()}
NODE

# Installer test path must not modify the live user systemd manager.
PATH="$TEST_ROOT/bin:$PATH" bash "$ROOT/install.sh" --test-root "$TEST_ROOT/isolated-installer" --apply >/dev/null
[[ -x "$TEST_ROOT/isolated-installer/home/.local/lib/nexus-recovery/contacts-independent-backup.sh" ]]

echo CONTACTS_INDEPENDENT_BACKUP_TEST_PASS
