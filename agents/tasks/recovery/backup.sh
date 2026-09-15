#!/usr/bin/env bash
set -euo pipefail
umask 077

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Required command unavailable: $1" >&2; exit 2; }; }
for cmd in node age curl sha256sum stat mktemp flock date install rm mkdir awk; do require_cmd "$cmd"; done

: "${GITLAB_PROJECT_ID:?GITLAB_PROJECT_ID is required}"
: "${GITLAB_DEPLOY_TOKEN_FILE:?GITLAB_DEPLOY_TOKEN_FILE is required}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT is required}"

[[ "$GITLAB_PROJECT_ID" =~ ^[0-9]+$ ]] || { echo "GITLAB_PROJECT_ID must be numeric" >&2; exit 2; }
[[ "$AGE_RECIPIENT" == age1* ]] || { echo "AGE_RECIPIENT must be a native age public recipient" >&2; exit 2; }

GITLAB_BASE_URL=${GITLAB_BASE_URL:-https://gitlab.com}
PACKAGE_NAME=task-sqlite
DB=/home/dubrovin/.openclaw/data/tasks/tasks.sqlite3
if [[ ${NEXUS_RECOVERY_TEST_MODE:-0} == 1 ]]; then
  : "${TASK_RECOVERY_DB:?TASK_RECOVERY_DB is required in test mode}"
  DB=$TASK_RECOVERY_DB
fi

[[ -f "$DB" ]] || { echo "Task database missing: $DB" >&2; exit 2; }
[[ -f "$GITLAB_DEPLOY_TOKEN_FILE" ]] || { echo "GitLab deploy token file missing" >&2; exit 2; }
TOKEN_MODE=$(stat -c %a "$GITLAB_DEPLOY_TOKEN_FILE")
case "$TOKEN_MODE" in 400|600) ;; *) echo "GitLab deploy token file must have mode 0400 or 0600" >&2; exit 2 ;; esac

STATE_ROOT=${XDG_STATE_HOME:-$HOME/.local/state}/nexus-recovery
STATUS_FILE="$STATE_ROOT/task-independent-backup.json"
LOCK_FILE="$STATE_ROOT/task-independent-backup.lock"
mkdir -p "$STATE_ROOT"
chmod 700 "$STATE_ROOT"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Another Task independent backup is running" >&2; exit 3; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ATTEMPT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/nexus-task-recovery.XXXXXX")
chmod 700 "$TMP_ROOT"
SNAPSHOT="$TMP_ROOT/tasks.sqlite3"
CIPHERTEXT="$TMP_ROOT/tasks.sqlite3.age"
MANIFEST="$TMP_ROOT/manifest.json"
CURL_CONFIG="$TMP_ROOT/curl.conf"

write_status() {
  local result=$1 message=$2 schema=${3:-} cipher_sha=${4:-} cipher_size=${5:-} package_version=${6:-}
  STATUS_RESULT="$result" STATUS_MESSAGE="$message" STATUS_SCHEMA="$schema" STATUS_SHA="$cipher_sha" STATUS_SIZE="$cipher_size" STATUS_VERSION="$package_version" STATUS_ATTEMPT="$ATTEMPT_AT" \
    node - "$STATUS_FILE" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
let prior = {};
try { prior = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
const result = process.env.STATUS_RESULT;
const out = {
  format: 'nexus-recovery-status-v1',
  class: 'task-sqlite',
  last_attempt_at: process.env.STATUS_ATTEMPT,
  last_result: result,
  last_message: process.env.STATUS_MESSAGE
};
if (prior.last_success_at) out.last_success_at = prior.last_success_at;
if (prior.last_success_package_version) out.last_success_package_version = prior.last_success_package_version;
if (result === 'PASS') {
  out.last_success_at = process.env.STATUS_ATTEMPT;
  out.last_success_package_version = process.env.STATUS_VERSION;
  out.sqlite_schema = Number(process.env.STATUS_SCHEMA);
  out.ciphertext_sha256 = process.env.STATUS_SHA;
  out.ciphertext_size = Number(process.env.STATUS_SIZE);
} else {
  if (Number.isSafeInteger(prior.sqlite_schema)) out.sqlite_schema = prior.sqlite_schema;
  if (prior.ciphertext_sha256) out.ciphertext_sha256 = prior.ciphertext_sha256;
  if (Number.isSafeInteger(prior.ciphertext_size)) out.ciphertext_size = prior.ciphertext_size;
}
const tmp = `${path}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', {mode: 0o600});
fs.renameSync(tmp, path);
NODE
}

cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT
trap 'code=$?; if [[ $code -ne 0 ]]; then write_status FAIL "backup failed" || true; fi' ERR

node - "$DB" "$SNAPSHOT" <<'NODE'
const {DatabaseSync, backup} = require('node:sqlite');
const fs = require('fs');
(async () => {
  const db = new DatabaseSync(process.argv[2], {readOnly: true});
  try { await backup(db, process.argv[3]); }
  finally { db.close(); }
  fs.chmodSync(process.argv[3], 0o600);
})().catch((error) => { console.error(error); process.exit(2); });
NODE

DB_META=$(node - "$SNAPSHOT" <<'NODE'
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], {readOnly: true});
try {
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const fk = db.prepare('PRAGMA foreign_key_check').all().length;
  const schema = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (integrity !== 'ok' || fk !== 0 || !Number.isSafeInteger(schema) || schema < 1) process.exit(2);
  process.stdout.write(JSON.stringify({schema, integrity, foreign_key_violations: fk}));
} finally { db.close(); }
NODE
)
SCHEMA=$(node -e 'const m=JSON.parse(process.argv[1]);process.stdout.write(String(m.schema))' "$DB_META")

age -r "$AGE_RECIPIENT" -o "$CIPHERTEXT" "$SNAPSHOT"
rm -f "$SNAPSHOT"
CIPHER_SHA=$(sha256sum "$CIPHERTEXT" | awk '{print $1}')
CIPHER_SIZE=$(stat -c %s "$CIPHERTEXT")

BACKUP_AT="$ATTEMPT_AT" PACKAGE_VERSION="$STAMP" CIPHER_SHA="$CIPHER_SHA" CIPHER_SIZE="$CIPHER_SIZE" SQLITE_SCHEMA="$SCHEMA" node - "$MANIFEST" <<'NODE'
const fs = require('fs');
const out = {
  format: 'nexus-recovery-manifest-v1',
  class: 'task-sqlite',
  snapshot_at: process.env.BACKUP_AT,
  package_version: process.env.PACKAGE_VERSION,
  payload: {
    file: 'tasks.sqlite3.age',
    sha256: process.env.CIPHER_SHA,
    size: Number(process.env.CIPHER_SIZE)
  },
  validation: {
    sqlite_schema: Number(process.env.SQLITE_SCHEMA),
    integrity_check: 'ok',
    foreign_key_violations: 0
  }
};
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n', {mode: 0o600});
NODE

TOKEN=$(<"$GITLAB_DEPLOY_TOKEN_FILE")
[[ -n "$TOKEN" && "$TOKEN" != *$'\n'* && "$TOKEN" != *$'\r'* ]] || { echo "Invalid GitLab deploy token file" >&2; exit 2; }
printf 'silent\nshow-error\nfail-with-body\nrequest = "PUT"\nheader = "DEPLOY-TOKEN: %s"\n' "$TOKEN" > "$CURL_CONFIG"
unset TOKEN
chmod 600 "$CURL_CONFIG"

upload() {
  local file=$1 remote_name=$2
  local url="${GITLAB_BASE_URL%/}/api/v4/projects/${GITLAB_PROJECT_ID}/packages/generic/${PACKAGE_NAME}/${STAMP}/${remote_name}"
  curl --config "$CURL_CONFIG" --upload-file "$file" "$url" >/dev/null
}

# Payload first; manifest last is the commit marker for a complete recovery point.
upload "$CIPHERTEXT" tasks.sqlite3.age
upload "$MANIFEST" manifest.json

write_status PASS "backup uploaded" "$SCHEMA" "$CIPHER_SHA" "$CIPHER_SIZE" "$STAMP"
echo "TASK_INDEPENDENT_BACKUP_PASS package_version=$STAMP schema=$SCHEMA"
