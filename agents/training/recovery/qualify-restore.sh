#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)

require_cmd(){ command -v "$1" >/dev/null 2>&1 || { echo "Required command unavailable: $1" >&2; exit 2; }; }
for cmd in node curl sha256sum stat mktemp rm mkdir date; do require_cmd "$cmd"; done

PACKAGE_VERSION=""
IDENTITY=""
EXPECTED=""
EVIDENCE=""
while (($#)); do
  case "$1" in
    --package-version) PACKAGE_VERSION=$2; shift 2 ;;
    --identity) IDENTITY=$2; shift 2 ;;
    --expected) EXPECTED=$2; shift 2 ;;
    --evidence) EVIDENCE=$2; shift 2 ;;
    --apply) shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${GITLAB_PROJECT_ID:?GITLAB_PROJECT_ID is required}"
: "${GITLAB_DEPLOY_TOKEN_FILE:?GITLAB_DEPLOY_TOKEN_FILE is required}"

[[ "$PACKAGE_VERSION" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "Invalid package version" >&2; exit 2; }
for value in "$IDENTITY" "$EXPECTED" "$EVIDENCE"; do
  [[ "$value" == /* ]] || { echo "Identity, expected, and evidence paths must be absolute" >&2; exit 2; }
done
[[ "$GITLAB_PROJECT_ID" =~ ^[0-9]+$ ]] || { echo "GITLAB_PROJECT_ID must be numeric" >&2; exit 2; }
[[ -f "$GITLAB_DEPLOY_TOKEN_FILE" ]] || { echo "GitLab deploy token file missing" >&2; exit 2; }
[[ -f "$IDENTITY" && -f "$EXPECTED" ]] || { echo "Restore qualification input missing" >&2; exit 2; }
[[ ! -e "$EVIDENCE" ]] || { echo "Evidence output already exists: $EVIDENCE" >&2; exit 2; }

for path in "$GITLAB_DEPLOY_TOKEN_FILE" "$IDENTITY"; do
  mode=$(stat -c %a "$path")
  case "$mode" in 400|600) ;; *) echo "Sensitive input must have mode 0400 or 0600: $path" >&2; exit 2 ;; esac
done

EXPECTED_META=$(node - "$EXPECTED" <<'NODE'
const fs=require('fs');
const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(x.format!=='training-restore-expected-v1')process.exit(2);
const ints=['sqlite_schema','sessions','exercises','session_exercises','sets','conditioning_results','active_program_version_number','cursor_sequence','cursor_cycle_number','open_sessions'];
for(const k of ints){
  if(!Number.isSafeInteger(x[k])||x[k]<0)process.exit(2);
}
process.stdout.write(JSON.stringify(x));
NODE
)
EXPECTED_SCHEMA=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).sqlite_schema))' "$EXPECTED_META")

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/training-restore-qualification.XXXXXX")
chmod 700 "$TMP_ROOT"
MANIFEST="$TMP_ROOT/manifest.json"
CIPHERTEXT="$TMP_ROOT/training.sqlite3.age"
RESTORED="$TMP_ROOT/restored.sqlite3"
CURL_CONFIG="$TMP_ROOT/curl.conf"
START_EPOCH=$(date -u +%s)
QUALIFIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cleanup(){
  rm -f "$RESTORED"
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

TOKEN=$(<"$GITLAB_DEPLOY_TOKEN_FILE")
[[ -n "$TOKEN" && "$TOKEN" != *$'\n'* && "$TOKEN" != *$'\r'* ]] || { echo "Invalid GitLab deploy token file" >&2; exit 2; }
printf 'silent\nshow-error\nfail-with-body\nheader = "DEPLOY-TOKEN: %s"\n' "$TOKEN" > "$CURL_CONFIG"
unset TOKEN
chmod 600 "$CURL_CONFIG"

BASE="${GITLAB_BASE_URL:-https://gitlab.com}"
BASE="${BASE%/}/api/v4/projects/${GITLAB_PROJECT_ID}/packages/generic/training-sqlite/${PACKAGE_VERSION}"

curl --config "$CURL_CONFIG" --output "$MANIFEST" "$BASE/manifest.json"
curl --config "$CURL_CONFIG" --output "$CIPHERTEXT" "$BASE/training.sqlite3.age"

MANIFEST_META=$(node - "$MANIFEST" "$PACKAGE_VERSION" <<'NODE'
const fs=require('fs');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(m.class!=='training-sqlite'||m.package_version!==process.argv[3]||typeof m.snapshot_at!=='string'||!m.snapshot_at)process.exit(2);
process.stdout.write(JSON.stringify({snapshot_at:m.snapshot_at,package_version:m.package_version}));
NODE
)
SNAPSHOT_AT=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).snapshot_at)' "$MANIFEST_META")

bash "$ROOT/restore.sh"   --ciphertext "$CIPHERTEXT"   --manifest "$MANIFEST"   --identity "$IDENTITY"   --output "$RESTORED"   --apply >/dev/null

ACTUAL=$(node - "$RESTORED" "$EXPECTED" <<'NODE'
const fs=require('fs');
const {DatabaseSync}=require('node:sqlite');
const expected=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const one=(q,...a)=>db.prepare(q).get(...a);
  const integrity=one('PRAGMA integrity_check').integrity_check;
  const fk=db.prepare('PRAGMA foreign_key_check').all().length;
  const schema=Number(one('PRAGMA user_version').user_version);
  const active=one("SELECT pv.version_number FROM program_versions pv WHERE pv.status='ACTIVE'");
  const cursor=one(`
    SELECT pc.cycle_number, ps.sequence
      FROM program_cursor pc
      JOIN program_versions pv ON pv.program_version_id=pc.program_version_id
      JOIN program_slots ps ON ps.program_slot_id=pc.next_program_slot_id
                           AND ps.program_version_id=pc.program_version_id
     WHERE pv.status='ACTIVE'`);
  const actual={
    sqlite_schema:schema,
    sessions:Number(one('SELECT count(*) n FROM training_sessions').n),
    exercises:Number(one('SELECT count(*) n FROM exercises').n),
    session_exercises:Number(one('SELECT count(*) n FROM session_exercises').n),
    sets:Number(one('SELECT count(*) n FROM session_sets').n),
    conditioning_results:Number(one('SELECT count(*) n FROM conditioning_results').n),
    active_program_version_number:Number(active?.version_number ?? -1),
    cursor_sequence:Number(cursor?.sequence ?? -1),
    cursor_cycle_number:Number(cursor?.cycle_number ?? -1),
    open_sessions:Number(one("SELECT count(*) n FROM training_sessions WHERE status IN ('ACTIVE','PAUSED')").n),
  };
  if(integrity!=='ok'||fk!==0)process.exit(2);
  for(const [key,value] of Object.entries(expected)){
    if(key==='format')continue;
    if(actual[key]!==value){
      console.error(`Training restore structural mismatch: ${key} expected=${value} actual=${actual[key]}`);
      process.exit(2);
    }
  }
  process.stdout.write(JSON.stringify(actual));
}finally{db.close();}
NODE
)

END_EPOCH=$(date -u +%s)
RTO_SEC=$((END_EPOCH-START_EPOCH))
SNAPSHOT_EPOCH=$(date -u -d "$SNAPSHOT_AT" +%s)
RPO_SEC=$((START_EPOCH-SNAPSHOT_EPOCH))
(( RPO_SEC >= 0 )) || { echo "Recovery point timestamp is in the future" >&2; exit 2; }
CIPHER_SHA=$(sha256sum "$CIPHERTEXT" | awk '{print $1}')

rm -f "$RESTORED"
[[ ! -e "$RESTORED" ]] || { echo "Plaintext cleanup failed" >&2; exit 2; }

mkdir -p "$(dirname "$EVIDENCE")"
QUALIFIED_AT="$QUALIFIED_AT" PACKAGE_VERSION="$PACKAGE_VERSION" CIPHER_SHA="$CIPHER_SHA" EXPECTED_SCHEMA="$EXPECTED_SCHEMA" RPO_SEC="$RPO_SEC" RTO_SEC="$RTO_SEC" ACTUAL="$ACTUAL" node - "$EVIDENCE" <<'NODE'
const fs=require('fs');
const out={
  format:'training-restore-evidence-v1',
  class:'training-sqlite',
  qualified_at:process.env.QUALIFIED_AT,
  package_version:process.env.PACKAGE_VERSION,
  ciphertext_sha256:process.env.CIPHER_SHA,
  sqlite_schema:Number(process.env.EXPECTED_SCHEMA),
  structural_validation:'PASS',
  observed_recovery_point_age_sec:Number(process.env.RPO_SEC),
  observed_restore_elapsed_sec:Number(process.env.RTO_SEC),
  plaintext_cleanup:'PASS',
  result:'PASS'
};
const tmp=`${process.argv[2]}.tmp-${process.pid}`;
fs.writeFileSync(tmp,JSON.stringify(out,null,2)+'\n',{mode:0o600});
fs.renameSync(tmp,process.argv[2]);
NODE

echo "TRAINING_RESTORE_QUALIFICATION_PASS package_version=$PACKAGE_VERSION schema=$EXPECTED_SCHEMA rpo_sec=$RPO_SEC rto_sec=$RTO_SEC"
