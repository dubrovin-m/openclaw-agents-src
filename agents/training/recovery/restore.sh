#!/usr/bin/env bash
set -euo pipefail
umask 077

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Required command unavailable: $1" >&2; exit 2; }; }
for cmd in node age sha256sum stat mktemp rm mkdir install; do require_cmd "$cmd"; done

CIPHERTEXT=""; MANIFEST=""; IDENTITY=""; OUTPUT=""
while (($#)); do
  case "$1" in
    --ciphertext) CIPHERTEXT=$2; shift 2 ;;
    --manifest) MANIFEST=$2; shift 2 ;;
    --identity) IDENTITY=$2; shift 2 ;;
    --output) OUTPUT=$2; shift 2 ;;
    --apply) shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

for value in "$CIPHERTEXT" "$MANIFEST" "$IDENTITY" "$OUTPUT"; do
  [[ "$value" == /* ]] || { echo "All restore paths must be absolute" >&2; exit 2; }
done
[[ -f "$CIPHERTEXT" && -f "$MANIFEST" && -f "$IDENTITY" ]] || { echo "Restore input is missing" >&2; exit 2; }
[[ ! -e "$OUTPUT" ]] || { echo "Restore output already exists: $OUTPUT" >&2; exit 2; }

IDENTITY_MODE=$(stat -c %a "$IDENTITY")
case "$IDENTITY_MODE" in 400|600) ;; *) echo "age identity file must have mode 0400 or 0600" >&2; exit 2 ;; esac

META=$(node - "$MANIFEST" <<'NODE'
const fs=require('fs');
const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(m.format!=='nexus-recovery-manifest-v1'||m.class!=='training-sqlite')process.exit(2);
if(!m.payload||m.payload.file!=='training.sqlite3.age'||!/^[a-f0-9]{64}$/i.test(m.payload.sha256)||!Number.isSafeInteger(m.payload.size)||m.payload.size<1)process.exit(2);
if(!m.validation||!Number.isSafeInteger(m.validation.sqlite_schema)||m.validation.sqlite_schema<1||m.validation.integrity_check!=='ok'||m.validation.foreign_key_violations!==0)process.exit(2);
process.stdout.write(JSON.stringify({sha:m.payload.sha256,size:m.payload.size,schema:m.validation.sqlite_schema}));
NODE
)
EXPECTED_SHA=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha)' "$META")
EXPECTED_SIZE=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).size))' "$META")
EXPECTED_SCHEMA=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).schema))' "$META")
ACTUAL_SHA=$(sha256sum "$CIPHERTEXT" | awk '{print $1}')
ACTUAL_SIZE=$(stat -c %s "$CIPHERTEXT")
[[ "$ACTUAL_SHA" == "$EXPECTED_SHA" && "$ACTUAL_SIZE" == "$EXPECTED_SIZE" ]] || { echo "Recovery payload does not match manifest" >&2; exit 2; }

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/nexus-training-restore.XXXXXX")
chmod 700 "$TMP_ROOT"
PLAIN="$TMP_ROOT/training.sqlite3"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

age -d -i "$IDENTITY" -o "$PLAIN" "$CIPHERTEXT"
chmod 600 "$PLAIN"

node - "$PLAIN" "$EXPECTED_SCHEMA" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
  const fk=db.prepare('PRAGMA foreign_key_check').all().length;
  const schema=Number(db.prepare('PRAGMA user_version').get().user_version);
  if(integrity!=='ok'||fk!==0||schema!==Number(process.argv[3]))process.exit(2);
}finally{db.close();}
NODE

mkdir -p "$(dirname "$OUTPUT")"
chmod 700 "$(dirname "$OUTPUT")"
install -m 600 "$PLAIN" "$OUTPUT"
echo "TRAINING_RESTORE_PASS schema=$EXPECTED_SCHEMA output=$OUTPUT"
