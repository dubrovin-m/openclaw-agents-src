#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d /tmp/task-independent-backup-test.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/home" "$TEST_ROOT/uploads"

cat > "$TEST_ROOT/bin/age" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
out=""; input=""
while (($#)); do
  case "$1" in -r) shift 2 ;; -o) out=$2; shift 2 ;; *) input=$1; shift ;; esac
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
    NEXUS_RECOVERY_TEST_MODE=1 TASK_RECOVERY_DB="$db" GITLAB_PROJECT_ID=123 \
    GITLAB_DEPLOY_TOKEN_FILE="$TEST_ROOT/token" AGE_RECIPIENT=age1syntheticrecipient \
    bash "$ROOT/backup.sh"
}

GOOD_DB="$TEST_ROOT/good.sqlite3"
create_db "$GOOD_DB" 0
run_backup "$GOOD_DB" "$TEST_ROOT/home" "$TEST_ROOT/uploads" "$TEST_ROOT/curl.log" >/dev/null
version=$(node -e 'const s=require(process.argv[1]);if(s.last_result!=="PASS"||s.sqlite_schema!==5)process.exit(1);process.stdout.write(s.last_success_package_version)' "$TEST_ROOT/home/state/nexus-recovery/task-independent-backup.json")
[[ -n "$version" ]]
[[ -s "$TEST_ROOT/uploads/tasks.sqlite3.age" && -s "$TEST_ROOT/uploads/manifest.json" ]]
node -e 'const m=require(process.argv[1]);if(m.class!=="task-sqlite"||m.validation.sqlite_schema!==5||m.validation.integrity_check!=="ok"||m.validation.foreign_key_violations!==0)process.exit(1)' "$TEST_ROOT/uploads/manifest.json"
! grep -q 'synthetic-secret-token' "$TEST_ROOT/curl.log"
[[ $(find /tmp -maxdepth 1 -name 'nexus-task-recovery.*' | wc -l) -eq 0 ]]

BAD_DB="$TEST_ROOT/bad.sqlite3"
create_db "$BAD_DB" 1
mkdir -p "$TEST_ROOT/bad-home" "$TEST_ROOT/bad-uploads"
set +e
run_backup "$BAD_DB" "$TEST_ROOT/bad-home" "$TEST_ROOT/bad-uploads" "$TEST_ROOT/bad-curl.log" >/dev/null 2>&1
code=$?
set -e
[[ $code -ne 0 ]]
[[ $(find "$TEST_ROOT/bad-uploads" -type f | wc -l) -eq 0 ]]
node -e 'const s=require(process.argv[1]);if(s.last_result!=="FAIL"||s.last_success_at)process.exit(1)' "$TEST_ROOT/bad-home/state/nexus-recovery/task-independent-backup.json"
[[ $(find /tmp -maxdepth 1 -name 'nexus-task-recovery.*' | wc -l) -eq 0 ]]

echo TASK_INDEPENDENT_BACKUP_TEST_PASS
