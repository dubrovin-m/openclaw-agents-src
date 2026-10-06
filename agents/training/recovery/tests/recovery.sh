#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TRAINING_ROOT=$(cd "$ROOT/.." && pwd)
STORE_MODULE="$TRAINING_ROOT/plugin/dist/store.js"
TEST_ROOT=$(mktemp -d /tmp/training-independent-recovery-test.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/home" "$TEST_ROOT/uploads"

cat > "$TEST_ROOT/bin/age" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
out=""; input=""; decrypt=0
while (($#)); do
  case "$1" in
    -d) decrypt=1; shift ;;
    -i|-r) shift 2 ;;
    -o) out=$2; shift 2 ;;
    *) input=$1; shift ;;
  esac
done
[[ -n "$out" && -n "$input" ]]
cp "$input" "$out"
SH

cat > "$TEST_ROOT/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$TEST_CURL_LOG"; printf '\n' >> "$TEST_CURL_LOG"
file=""; output=""; url=""
while (($#)); do
  case "$1" in
    --config) shift 2 ;;
    --upload-file) file=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
[[ -n "$url" ]]
if [[ -n "$file" ]]; then
  cp "$file" "$TEST_UPLOADS/${url##*/}"
elif [[ -n "$output" ]]; then
  cp "$TEST_DOWNLOADS/${url##*/}" "$output"
else
  exit 2
fi
SH
chmod +x "$TEST_ROOT/bin/age" "$TEST_ROOT/bin/curl"

printf '%s\n' 'synthetic-secret-token' > "$TEST_ROOT/token"
chmod 600 "$TEST_ROOT/token"
printf '%s\n' 'AGE-SECRET-KEY-1SYNTHETIC' > "$TEST_ROOT/identity"
chmod 600 "$TEST_ROOT/identity"

create_training_db() {
  local db_path=$1 bad_fk=$2
  STORE_MODULE="$STORE_MODULE" DB_PATH="$db_path" BAD_FK="$bad_fk" node --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
const { openTrainingStore } = await import(pathToFileURL(process.env.STORE_MODULE).href);
const db = openTrainingStore(process.env.DB_PATH);
const now = "2026-10-06T07:00:00.000Z";
try {
  db.prepare("INSERT INTO programs VALUES(?,?,?,?)").run("prog","Synthetic",null,now);
  db.prepare("INSERT INTO program_versions VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("ver","prog",1,"ACTIVE","{}","MIGRATION",null,now,null,now);
  db.prepare("INSERT INTO workout_templates VALUES(?,?,?,?,?)")
    .run("tpl","ver","Strength A","STRENGTH",null);
  db.prepare("INSERT INTO program_slots VALUES(?,?,?,?)").run("slot","ver",1,"tpl");
  if (process.env.BAD_FK === "1") {
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("INSERT INTO program_cursor VALUES(?,?,?,?)").run("ver",1,"missing-slot",now);
  } else {
    db.prepare("INSERT INTO program_cursor VALUES(?,?,?,?)").run("ver",1,"slot",now);
    db.prepare(`INSERT INTO training_sessions(
      training_session_id,program_version_id,workout_template_id,session_kind,session_source,
      recommended_program_slot_id,selected_program_slot_id,selection_source,
      cursor_before_slot_id,cursor_before_cycle_number,cursor_on_complete_slot_id,cursor_on_complete_cycle_number,
      status,started_at,ended_at,timezone_at_start,local_date,time_precision,overall_feedback,created_at
    ) VALUES(
      'sess','ver','tpl','STRENGTH','PROGRAM',
      'slot','slot','PROGRAM_RECOMMENDATION',
      'slot',1,'slot',2,
      'PAUSED',?,NULL,'Europe/Moscow','2026-10-06','EXACT',NULL,?
    )`).run(now,now);
    db.prepare("INSERT INTO training_session_pauses VALUES('pause','sess',?,NULL)").run('2026-10-06T07:30:00.000Z');
  }
} finally {
  db.close();
}
NODE
}

run_backup() {
  local db=$1 home=$2 uploads=$3 log=$4
  PATH="$TEST_ROOT/bin:$PATH" HOME="$home" XDG_STATE_HOME="$home/state" \
    TEST_UPLOADS="$uploads" TEST_CURL_LOG="$log" TRAINING_DB="$db" \
    GITLAB_PROJECT_ID=123 GITLAB_DEPLOY_TOKEN_FILE="$TEST_ROOT/token" \
    AGE_RECIPIENT=age1syntheticrecipient \
    bash "$ROOT/backup.sh"
}

GOOD_DB="$TEST_ROOT/good.sqlite3"
create_training_db "$GOOD_DB" 0
run_backup "$GOOD_DB" "$TEST_ROOT/home" "$TEST_ROOT/uploads" "$TEST_ROOT/curl.log" >/dev/null

STATUS="$TEST_ROOT/home/state/nexus-recovery/training-independent-backup.json"
version=$(node -e 'const s=require(process.argv[1]);if(s.last_result!=="PASS"||s.sqlite_schema!==2)process.exit(1);process.stdout.write(s.last_success_package_version)' "$STATUS")
[[ -n "$version" ]]
[[ -s "$TEST_ROOT/uploads/training.sqlite3.age" && -s "$TEST_ROOT/uploads/manifest.json" ]]
node -e 'const m=require(process.argv[1]);if(m.class!=="training-sqlite"||m.validation.sqlite_schema!==2||m.validation.integrity_check!=="ok"||m.validation.foreign_key_violations!==0)process.exit(1)' "$TEST_ROOT/uploads/manifest.json"
! grep -q 'synthetic-secret-token' "$TEST_ROOT/curl.log"
[[ $(find /tmp -maxdepth 1 -name 'nexus-training-recovery.*' | wc -l) -eq 0 ]]

RESTORED="$TEST_ROOT/restored/training.sqlite3"
PATH="$TEST_ROOT/bin:$PATH" bash "$ROOT/restore.sh" \
  --ciphertext "$TEST_ROOT/uploads/training.sqlite3.age" \
  --manifest "$TEST_ROOT/uploads/manifest.json" \
  --identity "$TEST_ROOT/identity" \
  --output "$RESTORED" --apply >/dev/null

node - "$RESTORED" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const schema=Number(db.prepare('PRAGMA user_version').get().user_version);
  const cursor=db.prepare("SELECT next_program_slot_id,cycle_number FROM program_cursor WHERE program_version_id='ver'").get();
  const session=db.prepare("SELECT status,training_session_id FROM training_sessions WHERE training_session_id='sess'").get();
  const pause=db.prepare("SELECT paused_at,resumed_at FROM training_session_pauses WHERE training_session_id='sess'").get();
  if(schema!==2||cursor.next_program_slot_id!=='slot'||cursor.cycle_number!==1||session.status!=='PAUSED'||!pause||pause.paused_at!=='2026-10-06T07:30:00.000Z'||pause.resumed_at!==null)process.exit(1);
}finally{db.close();}
NODE

EXPECTED="$TEST_ROOT/restore-expected.json"
EVIDENCE="$TEST_ROOT/restore-evidence.json"
cat > "$EXPECTED" <<'JSON'
{
  "format": "training-restore-expected-v1",
  "sqlite_schema": 2,
  "sessions": 1,
  "exercises": 0,
  "session_exercises": 0,
  "sets": 0,
  "conditioning_results": 0,
  "active_program_version_number": 1,
  "cursor_sequence": 1,
  "cursor_cycle_number": 1,
  "open_sessions": 1
}
JSON
chmod 600 "$EXPECTED"
PATH="$TEST_ROOT/bin:$PATH" HOME="$TEST_ROOT/home" TEST_UPLOADS="$TEST_ROOT/uploads" TEST_DOWNLOADS="$TEST_ROOT/uploads" TEST_CURL_LOG="$TEST_ROOT/qualify-curl.log" \
  GITLAB_PROJECT_ID=123 GITLAB_DEPLOY_TOKEN_FILE="$TEST_ROOT/token" GITLAB_BASE_URL=https://gitlab.test \
  bash "$ROOT/qualify-restore.sh" --package-version "$version" --identity "$TEST_ROOT/identity" --expected "$EXPECTED" --evidence "$EVIDENCE" --apply >/dev/null
node -e 'const e=require(process.argv[1]);if(e.result!=="PASS"||e.structural_validation!=="PASS"||e.plaintext_cleanup!=="PASS"||e.sqlite_schema!==2)process.exit(1)' "$EVIDENCE"
[[ $(find /tmp -maxdepth 1 -name 'training-restore-qualification.*' | wc -l) -eq 0 ]]

MISMATCH_DOWNLOADS="$TEST_ROOT/mismatch-downloads"
mkdir -p "$MISMATCH_DOWNLOADS"
cp "$TEST_ROOT/uploads/training.sqlite3.age" "$MISMATCH_DOWNLOADS/training.sqlite3.age"
node - "$TEST_ROOT/uploads/manifest.json" "$MISMATCH_DOWNLOADS/manifest.json" <<'NODE'
const fs=require('fs');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
m.package_version='19990101T000000Z';
fs.writeFileSync(process.argv[3],JSON.stringify(m,null,2)+'\n');
NODE
set +e
PATH="$TEST_ROOT/bin:$PATH" HOME="$TEST_ROOT/home" TEST_UPLOADS="$TEST_ROOT/uploads" TEST_DOWNLOADS="$MISMATCH_DOWNLOADS" TEST_CURL_LOG="$TEST_ROOT/mismatch-curl.log" \
  GITLAB_PROJECT_ID=123 GITLAB_DEPLOY_TOKEN_FILE="$TEST_ROOT/token" GITLAB_BASE_URL=https://gitlab.test \
  bash "$ROOT/qualify-restore.sh" --package-version "$version" --identity "$TEST_ROOT/identity" --expected "$EXPECTED" --evidence "$TEST_ROOT/mismatch-evidence.json" --apply >/dev/null 2>&1
code=$?
set -e
[[ $code -ne 0 && ! -e "$TEST_ROOT/mismatch-evidence.json" ]]

CROSS_DB="$TEST_ROOT/cross-version.sqlite3"
cp "$GOOD_DB" "$CROSS_DB"
node - "$CROSS_DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2]);
const now='2026-10-06T08:00:00.000Z';
try{
  db.prepare("INSERT INTO program_versions VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run('ver2','prog',2,'RETIRED','{}','MIGRATION',null,now,now,now);
  db.prepare("INSERT INTO workout_templates VALUES(?,?,?,?,?)")
    .run('tpl2','ver2','Other Strength A','STRENGTH',null);
  db.prepare("INSERT INTO program_slots VALUES(?,?,?,?)").run('slot2','ver2',1,'tpl2');
  db.prepare("UPDATE program_cursor SET next_program_slot_id='slot2' WHERE program_version_id='ver'").run();
}finally{db.close();}
NODE
mkdir -p "$TEST_ROOT/cross-home" "$TEST_ROOT/cross-uploads"
run_backup "$CROSS_DB" "$TEST_ROOT/cross-home" "$TEST_ROOT/cross-uploads" "$TEST_ROOT/cross-backup-curl.log" >/dev/null
cross_status="$TEST_ROOT/cross-home/state/nexus-recovery/training-independent-backup.json"
cross_version=$(node -e 'const s=require(process.argv[1]);if(s.last_result!=="PASS")process.exit(1);process.stdout.write(s.last_success_package_version)' "$cross_status")
set +e
PATH="$TEST_ROOT/bin:$PATH" HOME="$TEST_ROOT/cross-home" TEST_UPLOADS="$TEST_ROOT/cross-uploads" TEST_DOWNLOADS="$TEST_ROOT/cross-uploads" TEST_CURL_LOG="$TEST_ROOT/cross-qualify-curl.log" \
  GITLAB_PROJECT_ID=123 GITLAB_DEPLOY_TOKEN_FILE="$TEST_ROOT/token" GITLAB_BASE_URL=https://gitlab.test \
  bash "$ROOT/qualify-restore.sh" --package-version "$cross_version" --identity "$TEST_ROOT/identity" --expected "$EXPECTED" --evidence "$TEST_ROOT/cross-evidence.json" --apply >/dev/null 2>&1
code=$?
set -e
[[ $code -ne 0 && ! -e "$TEST_ROOT/cross-evidence.json" ]]
[[ $(find /tmp -maxdepth 1 -name 'training-restore-qualification.*' | wc -l) -eq 0 ]]

CORRUPT="$TEST_ROOT/corrupt.sqlite3.age"
cp "$TEST_ROOT/uploads/training.sqlite3.age" "$CORRUPT"
printf 'x' >> "$CORRUPT"
set +e
PATH="$TEST_ROOT/bin:$PATH" bash "$ROOT/restore.sh" \
  --ciphertext "$CORRUPT" \
  --manifest "$TEST_ROOT/uploads/manifest.json" \
  --identity "$TEST_ROOT/identity" \
  --output "$TEST_ROOT/should-not-exist.sqlite3" --apply >/dev/null 2>&1
code=$?
set -e
[[ $code -ne 0 && ! -e "$TEST_ROOT/should-not-exist.sqlite3" ]]

BAD_DB="$TEST_ROOT/bad.sqlite3"
create_training_db "$BAD_DB" 1
mkdir -p "$TEST_ROOT/bad-home" "$TEST_ROOT/bad-uploads"
set +e
run_backup "$BAD_DB" "$TEST_ROOT/bad-home" "$TEST_ROOT/bad-uploads" "$TEST_ROOT/bad-curl.log" >/dev/null 2>&1
code=$?
set -e
[[ $code -ne 0 ]]
[[ $(find "$TEST_ROOT/bad-uploads" -type f | wc -l) -eq 0 ]]
node -e 'const s=require(process.argv[1]);if(s.last_result!=="FAIL"||s.last_success_at)process.exit(1)' "$TEST_ROOT/bad-home/state/nexus-recovery/training-independent-backup.json"

SERVICE="$ROOT/training-independent-backup.service"
grep -Fxq 'NoNewPrivileges=true' "$SERVICE"
grep -Fxq 'PrivateTmp=true' "$SERVICE"
grep -Fxq 'ProtectSystem=full' "$SERVICE"
grep -Fxq 'ProtectControlGroups=true' "$SERVICE"
grep -Fxq 'ProtectKernelTunables=true' "$SERVICE"

PATH="$TEST_ROOT/bin:$PATH" bash "$ROOT/install.sh" --test-root "$TEST_ROOT/install-root" --apply >/dev/null
[[ -x "$TEST_ROOT/install-root/home/.local/lib/nexus-recovery/training-independent-backup.sh" ]]

[[ $(find /tmp -maxdepth 1 \( -name 'nexus-training-recovery.*' -o -name 'nexus-training-restore.*' \) | wc -l) -eq 0 ]]

echo 'TRA-REC-001 TRA-REC-002 TRAINING_RECOVERY_TEST_PASS'
