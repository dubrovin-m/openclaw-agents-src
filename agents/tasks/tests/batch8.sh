#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASKCTL=${1:-$ROOT/taskctl}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

node - "$ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const fail = (message) => { throw new Error(message); };

const release = json('release.json');
if (release?.generation?.sqlite_schema !== 9) fail('Batch 8 must validate Daily Review against the current schema v9 generation');

const tools = json('config/tasks-tools.json');
if (!Array.isArray(tools.allow) || tools.allow.filter((name) => name === 'task_daily_review').length !== 1) {
  fail('task_daily_review must be host-allowlisted exactly once');
}
if (tools.allow.filter((name) => name === 'task_management_review').length !== 1) {
  fail('task_management_review must be host-allowlisted exactly once');
}
if (tools.allow.filter((name) => name === 'task_reminder_dispatch').length !== 1) {
  fail('task_reminder_dispatch must be host-allowlisted exactly once for scheduler-only execution');
}
for (const required of ['deadline_request_get','deadline_request_create','deadline_request_approve','deadline_request_reject']) {
  if (tools.allow.filter((name) => name === required).length !== 1) fail(required + ' must be host-allowlisted exactly once');
}
for (const denied of ['write','edit','apply_patch','exec','process','gateway','cron','browser','sessions_spawn','sessions_send','subagents','nodes']) {
  if (!tools.deny?.includes(denied)) fail(`Task Agent deny policy lost ${denied}`);
}

const manifest = json('plugins/taskctl/openclaw.plugin.json');
const staticTools = manifest?.contracts?.tools;
if (!Array.isArray(staticTools) || staticTools.length !== 67) fail('Batch 8 static plugin registry must contain 67 tools');
if (staticTools.filter((name) => name === 'task_daily_review').length !== 1) fail('static registry must declare task_daily_review exactly once');
if (staticTools.filter((name) => name === 'task_management_review').length !== 1) fail('static registry must declare task_management_review exactly once');
if (staticTools.filter((name) => name === 'task_reminder_dispatch').length !== 1) fail('static registry must declare task_reminder_dispatch exactly once');
if (manifest?.toolMetadata?.task_daily_review?.optional !== true) fail('task_daily_review must remain optional');
if (manifest?.toolMetadata?.task_management_review?.optional !== true) fail('task_management_review must remain optional');

const contract = read('plugins/taskctl/src/contract.ts');
if (/task_daily_review/.test(contract)) fail('task_daily_review must not enter TASKCTL_ACTIONS/ordinary Task contracts');
if (/task_management_review/.test(contract)) fail('task_management_review must not enter TASKCTL_ACTIONS/ordinary Task contracts');
if (/task_reminder_dispatch/.test(contract)) fail('task_reminder_dispatch must not enter TASKCTL_ACTIONS/ordinary Task contracts');


const index = read('plugins/taskctl/src/index.ts');
for (const required of ['argv:["review","snapshot"]', 'shell:false', 'runDailyReviewSnapshot', 'argv:["review","management-snapshot"]', 'runManagementReviewSnapshot']) {
  if (!index.includes(required)) fail(`hidden taskctl snapshot bridge lost invariant: ${required}`);
}
const taskctl = read('taskctl');
for (const required of ["const IMPLEMENTATION_VERSION = '0.4.13';", 'function openReadDb()', 'readOnly:true', 'PRAGMA query_only=ON', "scope==='review'&&action==='snapshot'", "scope==='review'&&action==='management-snapshot'"]) {
  if (!taskctl.includes(required)) fail(`taskctl hidden review snapshot lost invariant: ${required}`);
}
if (/review[_-]?snapshot|review snapshot/.test(contract)) fail('hidden review snapshot must not enter ordinary Task contracts');
const plugin = read('plugins/taskctl/src/plugin.ts');
if (!plugin.includes('factory: ({ api, toolContext }) => createDailyReviewTool(api, toolContext)')) {
  fail('Daily Review must remain a context-gated factory tool');
}
if (!plugin.includes('factory: ({ api, toolContext }) => createManagementReviewTool(api, toolContext)')) {
  fail('Management Review must remain a context-gated factory tool');
}

const daily = read('plugins/taskctl/src/daily-review.ts');
for (const required of [
  'Europe/Moscow',
  '30 9 * * *',
  '0 17 * * *',
  'agent:tasks:cron:',
  'api.runtime.gateway.request',
  'api.runtime.agent.runEmbeddedAgent',
  'sessionPersistence: "detached"',
  'disableTools: true',
  'modelRun: true',
  'TASKCTL_SCHEMA_VERSION = 9',
  'runDailyReviewSnapshot',
  'completionStatus === "succeeded"',
  'deliveryStatus === "delivered"',
]) {
  if (!daily.includes(required)) fail(`Daily Review lost required invariant: ${required}`);
}
for (const forbidden of [
  'child_process',
  'DatabaseSync',
  'node:sqlite',
  '.openclaw/data/tasks/tasks.sqlite3',
  'spawn("openclaw"',
  'executeTaskctl',
  'text-embedding',
  'vector database',
  'similarity index',
]) {
  if (daily.includes(forbidden)) fail(`Daily Review introduced forbidden path: ${forbidden}`);
}
if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/.test(daily)) {
  fail('Daily Review implementation contains a SQL mutation verb');
}

const tests = read('plugins/taskctl/src/plugin.test.ts');
if (!tests.includes('ordinaryToolNames()).toHaveLength(64)')) fail('ordinary 64-tool surface regression is not asserted');
if (!tests.includes('expect(byName.has(TASK_DAILY_REVIEW_TOOL)).toBe(false)')) fail('ordinary normalized surface must exclude Daily Review');
if (!tests.includes('expect(byName.has(TASK_REMINDER_DISPATCH_TOOL)).toBe(false)')) fail('ordinary normalized surface must exclude Reminder dispatcher');

const reviewTests = read('plugins/taskctl/src/daily-review.test.ts');
for (const requiredTest of [
  'keeps a due-today task in Today even after its due_time has passed',
  'does not silently truncate an OPEN population larger than 200 tasks',
  'fails the review when semantic output is invalid instead of claiming no duplicates',
  'uses the in-process plugin Gateway runtime for native Automation reads',
  'prepends Inbox count only for the morning review, including zero',
]) {
  if (!reviewTests.includes(requiredTest)) fail(`missing Batch 8 regression: ${requiredTest}`);
}
NODE

DB="$TMP/tasks.sqlite3"
CDB="$TMP/tasks-contacts.sqlite3"
init=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_CONTACTS_DB="$CDB" "$TASKCTL" init)
node - "$init" <<'NODE'
const result = JSON.parse(process.argv[2]);
if (result.schema_version !== 9 || result.implementation_version !== '0.4.13') throw new Error(`Batch 8 runtime initialized ${result.implementation_version} schema ${result.schema_version}, expected taskctl 0.4.13 / schema 9`);
NODE


BOUNDARY="2026-09-05T06:30:00.000Z"
node - "$DB" "$CDB" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const cdb = new DatabaseSync(process.argv[3]);
try {
  const person = Number(cdb.prepare("SELECT id FROM people WHERE is_self=1 AND status='ACTIVE'").get().id);
  const group = Number(cdb.prepare("INSERT INTO person_groups(display_name,created_at,updated_at) VALUES('Office CEO','2026-09-05T05:00:00.000Z','2026-09-05T05:00:00.000Z')").run().lastInsertRowid);
  cdb.prepare("INSERT INTO person_group_members(group_id,person_id,created_at) VALUES(?,?,'2026-09-05T05:00:00.000Z')").run(group,person);
  db.prepare("INSERT INTO labels(display_name,emoji,created_at) VALUES('Работа','💼','2026-09-05T05:00:00.000Z')").run();
  const personalLabel = Number(db.prepare("INSERT INTO labels(display_name,emoji,created_at) VALUES('Personal fixture','🏠','2026-09-05T05:00:00.000Z')").run().lastInsertRowid);
  db.prepare("INSERT INTO task_domain_bindings(binding_key,entity_id,created_at,updated_at) VALUES('OFFICE_CEO_GROUP',?,'2026-09-05T05:00:00.000Z','2026-09-05T05:00:00.000Z')").run(group);
  db.prepare("INSERT INTO task_domain_bindings(binding_key,entity_id,created_at,updated_at) VALUES('PERSONAL_LABEL',?,'2026-09-05T05:00:00.000Z','2026-09-05T05:00:00.000Z')").run(personalLabel);
  db.prepare("INSERT INTO projects(title,status,created_at,completed_at) VALUES('Batch 8','ACTIVE','2026-09-05T05:00:00.000Z',NULL)").run();
  db.exec('BEGIN IMMEDIATE;');
  db.prepare("INSERT INTO inbox_items(content,received_at,capture_key) VALUES('Before boundary','2026-09-05T06:00:00.000Z','batch8-inbox-before')").run();
  db.prepare("INSERT INTO inbox_items(content,received_at,capture_key) VALUES('After boundary','2026-09-05T06:30:00.001Z','batch8-inbox-after')").run();
  const insert = db.prepare("INSERT INTO tasks(title,assignee_id,status,due_date,due_time,created_at,completed_at,project_id) VALUES(?,?,?,NULL,NULL,?,NULL,?)");
  for (let id = 1; id <= 250; id += 1) insert.run(`Open ${id}`, person, 'OPEN', '2026-09-05T06:00:00.000Z', id === 1 ? 1 : null);
  insert.run('Done', person, 'CANCELLED', '2026-09-05T06:00:00.000Z', null);
  insert.run('Future', person, 'OPEN', '2026-09-05T06:30:00.001Z', null);
  db.prepare('INSERT INTO task_labels(task_id,label_id) VALUES(1,1)').run();
  db.exec('COMMIT;');
} catch (error) {
  try { db.exec('ROLLBACK;'); } catch {}
  throw error;
} finally { db.close(); cdb.close(); }
NODE
snapshot=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$DB" TASKCTL_CONTACTS_DB="$CDB" TASKCTL_PAYLOAD="{\"boundary\":\"$BOUNDARY\"}" "$TASKCTL" review snapshot)
node - "$snapshot" <<'NODE'
const result = JSON.parse(process.argv[2]);
if (!result.ok || result.implementation_version !== '0.4.13' || result.schema_version !== 9 || result.boundary !== '2026-09-05T06:30:00.000Z') process.exit(2);
if (!Array.isArray(result.tasks) || result.tasks.length !== 250) process.exit(3);
if (result.tasks.some((task) => task.title === 'Done' || task.title === 'Future')) process.exit(4);
const first = result.tasks.find((task) => task.id === 'T-1');
if (!first || first.project_id !== 'PRJ-1' || first.project_title !== 'Batch 8' || first.assignee !== 'Дубровин М.' || first.labels?.[0]?.display_name !== 'Работа' || first.office_ceo !== true || first.personal !== false) process.exit(5);
if (result.inbox_count !== 1) process.exit(6);
NODE

MANAGEMENT_DB="$TMP/management.sqlite3"
MANAGEMENT_CDB="$TMP/management-contacts.sqlite3"
TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$MANAGEMENT_DB" TASKCTL_CONTACTS_DB="$MANAGEMENT_CDB" "$TASKCTL" init >/dev/null
node - "$MANAGEMENT_DB" "$MANAGEMENT_CDB" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const cdb = new DatabaseSync(process.argv[3]);
try {
  const at='2026-09-15T09:00:00.000Z';
  const addPerson=cdb.prepare("INSERT INTO people(display_name,organization,title,is_self,status,merged_into,created_at,updated_at) VALUES(?,NULL,NULL,0,'ACTIVE',NULL,?,?)");
  const ivanov=Number(addPerson.run('Иванов И.',at,at).lastInsertRowid);
  const petrov=Number(addPerson.run('Петров П.',at,at).lastInsertRowid);
  const savelev=Number(addPerson.run('Савельев Е.',at,at).lastInsertRowid);
  const savelevOld=Number(addPerson.run('Савельев старый',at,at).lastInsertRowid);
  cdb.prepare("UPDATE people SET status='MERGED',merged_into=?,updated_at=? WHERE id=?").run(savelev,at,savelevOld);
  const group=Number(cdb.prepare("INSERT INTO person_groups(display_name,created_at,updated_at) VALUES('Office CEO',?,?)").run(at,at).lastInsertRowid);
  cdb.prepare('INSERT INTO person_group_members(group_id,person_id,created_at) VALUES(?,?,?)').run(group,savelev,at);
  db.prepare("INSERT INTO task_domain_bindings(binding_key,entity_id,created_at,updated_at) VALUES('OFFICE_CEO_GROUP',?,?,?)").run(group,at,at);
  const add=db.prepare('INSERT INTO tasks(title,assignee_id,status,due_date,due_time,created_at,completed_at,project_id) VALUES(?,?,?,?,?,?,?,NULL)');
  add.run('Старое поручение',ivanov,'OPEN','2026-09-10',null,at,null);
  add.run('Срок сегодня',ivanov,'OPEN','2026-09-16',null,at,null);
  add.run('Исключенное поручение',savelevOld,'OPEN','2026-09-10',null,at,null);
  add.run('Закрыто сегодня',petrov,'DONE','2026-09-15',null,at,'2026-09-16T10:00:00.000Z');
  add.run('Закрыто вчера',petrov,'DONE','2026-09-14',null,at,'2026-09-15T10:00:00.000Z');
} finally { db.close(); cdb.close(); }
NODE
management=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$MANAGEMENT_DB" TASKCTL_CONTACTS_DB="$MANAGEMENT_CDB" TASKCTL_PAYLOAD='{"boundary":"2026-09-16T16:00:00.000Z"}' "$TASKCTL" review management-snapshot)
node - "$management" <<'NODE'
const result=JSON.parse(process.argv[2]);
if(!result.ok||result.local_date!=='2026-09-16'||result.not_completed_count!==2||result.completed_count!==1||result.office_ceo_group_id!=='PG-1')process.exit(2);
const notCompleted=result.not_completed.map(task=>task.title).sort();
if(JSON.stringify(notCompleted)!==JSON.stringify(['Срок сегодня','Старое поручение'].sort()))process.exit(3);
if(result.not_completed.some(task=>task.title==='Исключенное поручение')||result.completed.some(task=>task.title==='Закрыто вчера'))process.exit(4);
if(!result.completed.some(task=>task.title==='Закрыто сегодня'))process.exit(5);
NODE

LEGACY_DB="$TMP/schema4.sqlite3"
LEGACY_CDB="$TMP/schema4-contacts.sqlite3"
node - "$LEGACY_DB" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
try { db.exec('PRAGMA user_version=4;'); } finally { db.close(); }
NODE
set +e
legacy=$(TASKCTL_ALLOW_DB_OVERRIDE=1 TASKCTL_DB="$LEGACY_DB" TASKCTL_CONTACTS_DB="$LEGACY_CDB" TASKCTL_PAYLOAD="{\"boundary\":\"$BOUNDARY\"}" "$TASKCTL" review snapshot)
legacy_rc=$?
set -e
[ "$legacy_rc" -ne 0 ]
contains_legacy=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.error?.code||"")' "$legacy")
[ "$contains_legacy" = "UNSUPPORTED_SCHEMA" ]
[ ! -e "$LEGACY_CDB" ]
node - "$LEGACY_DB" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  if (Number(db.prepare('PRAGMA user_version').get().user_version) !== 4) process.exit(2);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()) process.exit(3);
} finally { db.close(); }
NODE

printf 'BATCH8_OK\n'
