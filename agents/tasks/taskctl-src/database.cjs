'use strict';

const {
  fs, path, DatabaseSync, contacts, contactStore, IMPLEMENTATION_VERSION, SCHEMA_VERSION, TZ,
  SELF_NAME, DB_PATH, AppError, ci, localDate, localTime,
} = require('./runtime.cjs');

const CREATE_CURRENT = [
  "CREATE TABLE IF NOT EXISTS inbox_items(id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL CHECK(length(trim(content))>0), received_at TEXT NOT NULL, capture_key TEXT NOT NULL UNIQUE) STRICT;",
  "CREATE TABLE IF NOT EXISTS capture_receipts(capture_key TEXT PRIMARY KEY, inbox_id INTEGER, state TEXT NOT NULL CHECK(state IN ('ACTIVE','RESOLVED','DISCARDED')), received_at TEXT NOT NULL) STRICT;",
  "CREATE TABLE IF NOT EXISTS labels(id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL CHECK(length(trim(display_name))>0), emoji TEXT, created_at TEXT NOT NULL) STRICT;",
  "CREATE TABLE IF NOT EXISTS label_aliases(label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE, alias TEXT NOT NULL CHECK(length(trim(alias))>0), PRIMARY KEY(label_id,alias)) STRICT;",
  "CREATE TABLE IF NOT EXISTS term_aliases(alias TEXT PRIMARY KEY CHECK(length(trim(alias))>0), expansion TEXT NOT NULL CHECK(length(trim(expansion))>0), created_at TEXT NOT NULL) STRICT;",
  "CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL CHECK(length(trim(title))>0), status TEXT NOT NULL CHECK(status IN ('ACTIVE','DONE','CANCELLED')), created_at TEXT NOT NULL, completed_at TEXT, CHECK((status='DONE' AND completed_at IS NOT NULL) OR (status!='DONE' AND completed_at IS NULL))) STRICT;",
  "CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL CHECK(length(trim(title))>0), assignee_id INTEGER NOT NULL CHECK(assignee_id>0), status TEXT NOT NULL CHECK(status IN ('OPEN','DONE','CANCELLED')), due_date TEXT, due_time TEXT CHECK(due_time IS NULL OR (due_date IS NOT NULL AND length(due_time)=5 AND due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr(due_time,1,2) AS INTEGER)<=23)), created_at TEXT NOT NULL, completed_at TEXT, project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT, CHECK((status='DONE' AND completed_at IS NOT NULL) OR (status!='DONE' AND completed_at IS NULL))) STRICT;",
  "CREATE TABLE IF NOT EXISTS task_labels(task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE RESTRICT, PRIMARY KEY(task_id,label_id)) STRICT;",
  "CREATE TABLE IF NOT EXISTS task_comments(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, content TEXT NOT NULL CHECK(length(trim(content))>0), created_at TEXT NOT NULL) STRICT;",
  "CREATE TABLE IF NOT EXISTS task_events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT, event_type TEXT NOT NULL CHECK(event_type IN ('CREATED','TITLE_CHANGED','ASSIGNEE_CHANGED','DUE_DATE_CHANGED','DUE_TIME_CHANGED','STATUS_CHANGED')), old_value TEXT, new_value TEXT, reason TEXT, occurred_at TEXT NOT NULL) STRICT;",
  "CREATE TABLE IF NOT EXISTS operation_results(operation_key TEXT PRIMARY KEY, operation_type TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;",
  "CREATE TABLE IF NOT EXISTS recurrences(id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL CHECK(status IN ('ACTIVE','PAUSED','CANCELLED')), mode TEXT NOT NULL CHECK(mode IN ('CALENDAR','AFTER_COMPLETION')), title TEXT NOT NULL CHECK(length(trim(title))>0), assignee_id INTEGER NOT NULL CHECK(assignee_id>0), due_time TEXT CHECK(due_time IS NULL OR (length(due_time)=5 AND due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr(due_time,1,2) AS INTEGER)<=23)), target_project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT, rule_json TEXT NOT NULL CHECK(length(trim(rule_json))>0), calendar_cursor_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancelled_at TEXT, CHECK((status='CANCELLED' AND cancelled_at IS NOT NULL) OR (status!='CANCELLED' AND cancelled_at IS NULL)), CHECK((mode='CALENDAR' AND calendar_cursor_date IS NOT NULL) OR (mode='AFTER_COMPLETION' AND calendar_cursor_date IS NULL))) STRICT;",
  "CREATE TABLE IF NOT EXISTS recurrence_labels(recurrence_id INTEGER NOT NULL REFERENCES recurrences(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE RESTRICT, PRIMARY KEY(recurrence_id,label_id)) STRICT;",
  "CREATE TABLE IF NOT EXISTS recurrence_occurrences(id INTEGER PRIMARY KEY AUTOINCREMENT, recurrence_id INTEGER NOT NULL REFERENCES recurrences(id) ON DELETE RESTRICT, occurrence_key TEXT NOT NULL CHECK(length(trim(occurrence_key))>0), occurrence_date TEXT, predecessor_task_id INTEGER REFERENCES tasks(id) ON DELETE RESTRICT, task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT, template_json TEXT NOT NULL CHECK(length(trim(template_json))>0), generated_at TEXT NOT NULL, UNIQUE(recurrence_id,occurrence_key)) STRICT;",
  "CREATE TABLE IF NOT EXISTS recurrence_events(id INTEGER PRIMARY KEY AUTOINCREMENT, recurrence_id INTEGER NOT NULL REFERENCES recurrences(id) ON DELETE RESTRICT, event_type TEXT NOT NULL CHECK(event_type IN ('CREATED','RULE_CHANGED','TEMPLATE_CHANGED','PAUSED','RESUMED','CANCELLED','CYCLE_ANCHORED')), old_value TEXT, new_value TEXT, reason TEXT, occurred_at TEXT NOT NULL) STRICT;",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_recurrence_occurrence_predecessor ON recurrence_occurrences(predecessor_task_id) WHERE predecessor_task_id IS NOT NULL;",
  "CREATE INDEX IF NOT EXISTS idx_recurrences_status_mode ON recurrences(status,mode,id);",
  "CREATE INDEX IF NOT EXISTS idx_recurrences_project_status ON recurrences(target_project_id,status,id);",
  "CREATE INDEX IF NOT EXISTS idx_recurrence_occurrences_recurrence ON recurrence_occurrences(recurrence_id,id);",
  "CREATE INDEX IF NOT EXISTS idx_recurrence_events_recurrence ON recurrence_events(recurrence_id,id);",
  "CREATE INDEX IF NOT EXISTS idx_recurrence_labels_label ON recurrence_labels(label_id,recurrence_id);",
  "CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status,due_date,due_time);",
  "CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee_id,status);",
  "CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id,status,id);",
  "CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id,id);",
  "CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id,id);",
  "CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id,task_id);",
  "CREATE INDEX IF NOT EXISTS idx_label_aliases_alias ON label_aliases(alias);",
  "CREATE TABLE IF NOT EXISTS reminders(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER REFERENCES tasks(id) ON DELETE RESTRICT, text TEXT, trigger_at TEXT NOT NULL CHECK(length(trim(trigger_at))>0), status TEXT NOT NULL CHECK(status IN ('ACTIVE','CLOSED')), close_reason TEXT CHECK(close_reason IS NULL OR close_reason IN ('DELIVERED','TASK_COMPLETED','TASK_CANCELLED','USER_CANCELLED')), created_at TEXT NOT NULL, closed_at TEXT, claim_token TEXT, claimed_at TEXT, claim_expires_at TEXT, CHECK((task_id IS NOT NULL AND text IS NULL) OR (task_id IS NULL AND text IS NOT NULL AND length(trim(text))>0)), CHECK((status='ACTIVE' AND close_reason IS NULL AND closed_at IS NULL) OR (status='CLOSED' AND close_reason IS NOT NULL AND closed_at IS NOT NULL)), CHECK((claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL) OR (status='ACTIVE' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL))) STRICT;",
  "CREATE INDEX IF NOT EXISTS idx_reminders_status_trigger ON reminders(status,trigger_at,id);",
  "CREATE INDEX IF NOT EXISTS idx_reminders_task_status ON reminders(task_id,status,id);",
  "CREATE INDEX IF NOT EXISTS idx_reminders_claim ON reminders(claim_token,status,id);",
  "CREATE TABLE IF NOT EXISTS task_domain_bindings(binding_key TEXT PRIMARY KEY CHECK(binding_key IN ('OFFICE_CEO_GROUP','PERSONAL_LABEL')), entity_id INTEGER NOT NULL CHECK(entity_id>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;",
  "CREATE TABLE IF NOT EXISTS deadline_change_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT, base_due_date TEXT, base_due_time TEXT, requested_due_date TEXT, requested_due_time TEXT, reason TEXT NOT NULL CHECK(length(trim(reason))>0), status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')), approved_due_date TEXT, approved_due_time TEXT, created_at TEXT NOT NULL, resolved_at TEXT) STRICT;",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_deadline_change_requests_pending_task ON deadline_change_requests(task_id) WHERE status='PENDING';",
  "CREATE INDEX IF NOT EXISTS idx_deadline_change_requests_task ON deadline_change_requests(task_id,id);",
].join('\n');

function migrate(db){
  const version=Number(db.prepare('PRAGMA main.user_version').get().user_version);
  if(version===0){
    contactStore.attachContacts(db,contactStore.contactsDbPath(),{create:true});contactStore.configureJournals(db);db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    try{contacts.ensureSchema(db,'contacts');contacts.ensureSingleSelf(db,'contacts',SELF_NAME);db.exec(CREATE_CURRENT);db.exec(`PRAGMA main.user_version=${SCHEMA_VERSION}; COMMIT;`);}
    catch(e){try{db.exec('ROLLBACK;');}catch{}throw e;}
    return;
  }
  if(version!==SCHEMA_VERSION)throw new AppError('UNSUPPORTED_SCHEMA',`Unsupported schema version ${version}; target schema is ${SCHEMA_VERSION}`);
  contactStore.prepareCurrent(db);
}
function openDb(){const dir=path.dirname(DB_PATH);fs.mkdirSync(dir,{recursive:true,mode:0o700});try{fs.chmodSync(dir,0o700);}catch{}const db=new DatabaseSync(DB_PATH,{timeout:5000});db.function('task_ci',{deterministic:true},ci);migrate(db);db.exec('PRAGMA foreign_keys=ON;');try{fs.chmodSync(DB_PATH,0o600);}catch{}return db;}
function openReadDb(){const db=new DatabaseSync(DB_PATH,{readOnly:true,timeout:5000});db.function('task_ci',{deterministic:true},ci);db.exec('PRAGMA foreign_keys=ON;');return db;}
function healthSnapshot(){
  if(!fs.existsSync(DB_PATH))throw new AppError('DATABASE_NOT_FOUND','Task database is missing',{database:DB_PATH},3);
  const db=openReadDb();let contactsDb;
  try{
    db.exec('PRAGMA query_only=ON;');
    const schemaVersion=Number(db.prepare('PRAGMA user_version').get().user_version);
    if(schemaVersion!==SCHEMA_VERSION)throw new AppError('UNSUPPORTED_SCHEMA',`Health requires schema ${SCHEMA_VERSION}; found ${schemaVersion}`,{found:schemaVersion,target:SCHEMA_VERSION});
    const requiredTables=['inbox_items','capture_receipts','labels','label_aliases','term_aliases','projects','tasks','task_labels','task_comments','task_events','operation_results','recurrences','recurrence_labels','recurrence_occurrences','recurrence_events','reminders','deadline_change_requests','task_domain_bindings'];
    const present=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
    const missingTables=requiredTables.filter(name=>!present.has(name));
    if(missingTables.length)throw new AppError('SCHEMA_INVALID','Task database is missing required tables',{missing_tables:missingTables});
    const integrityRows=db.prepare('PRAGMA integrity_check').all();
    const foreignKeyRows=db.prepare('PRAGMA foreign_key_check').all();
    if(integrityRows.length!==1||integrityRows[0].integrity_check!=='ok'||foreignKeyRows.length!==0)throw new AppError('INTEGRITY_ERROR','Task database integrity validation failed',{integrity:integrityRows.map(x=>x.integrity_check),foreign_key_violations:foreignKeyRows.length});
    const contactsPath=contactStore.contactsDbPath();
    if(!fs.existsSync(contactsPath))throw new AppError('CONTACTS_NOT_FOUND','Contacts database is missing',{database:contactsPath},3);
    contactsDb=new DatabaseSync(contactsPath,{readOnly:true,timeout:5000});
    contactsDb.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
    const contactsSchemaVersion=Number(contactsDb.prepare('PRAGMA user_version').get().user_version);
    if(contactsSchemaVersion!==contacts.CONTACT_SCHEMA_VERSION)throw new AppError('UNSUPPORTED_CONTACTS_SCHEMA',`Health requires Contacts schema ${contacts.CONTACT_SCHEMA_VERSION}; found ${contactsSchemaVersion}`,{found:contactsSchemaVersion,target:contacts.CONTACT_SCHEMA_VERSION});
    const contactsIntegrityRows=contactsDb.prepare('PRAGMA integrity_check').all();
    const contactsForeignKeyRows=contactsDb.prepare('PRAGMA foreign_key_check').all();
    let semanticIntegrity;
    try{semanticIntegrity=contacts.integrity(contactsDb);}catch(error){throw new AppError('CONTACTS_SCHEMA_INVALID','Contacts schema validation failed',{message:error?.message||String(error)});}
    if(contactsIntegrityRows.length!==1||contactsIntegrityRows[0].integrity_check!=='ok'||contactsForeignKeyRows.length!==0||semanticIntegrity.ok!==true)throw new AppError('CONTACTS_INTEGRITY_ERROR','Contacts database integrity validation failed',{integrity:contactsIntegrityRows.map(x=>x.integrity_check),foreign_key_violations:contactsForeignKeyRows.length,semantic_errors:semanticIntegrity.errors??[]});
    const personIds=new Set();
    for(const row of db.prepare('SELECT DISTINCT assignee_id FROM tasks').all())personIds.add(Number(row.assignee_id));
    for(const row of db.prepare('SELECT DISTINCT assignee_id FROM recurrences').all())personIds.add(Number(row.assignee_id));
    for(const personId of personIds)if(!contacts.canonicalPerson(contactsDb,personId))throw new AppError('CONTACT_REFERENCE_INVALID',`Dangling Person reference P-${personId}`);
    return{ok:true,implementation_version:IMPLEMENTATION_VERSION,schema_version:schemaVersion,contacts_schema_version:contactsSchemaVersion,sqlite_version:db.prepare('SELECT sqlite_version() v').get().v,database:DB_PATH,timezone:TZ,local_date:localDate(),local_time:localTime(),integrity:{ok:true},counts:{inbox:db.prepare('SELECT count(*) n FROM inbox_items').get().n,tasks:db.prepare('SELECT count(*) n FROM tasks').get().n,projects:db.prepare('SELECT count(*) n FROM projects').get().n,people:contactsDb.prepare('SELECT count(*) n FROM people').get().n,active_people:contactsDb.prepare("SELECT count(*) n FROM people WHERE status='ACTIVE'").get().n,labels:db.prepare('SELECT count(*) n FROM labels').get().n,comments:db.prepare('SELECT count(*) n FROM task_comments').get().n,events:db.prepare('SELECT count(*) n FROM task_events').get().n,terms:db.prepare('SELECT count(*) n FROM term_aliases').get().n,recurrences:db.prepare('SELECT count(*) n FROM recurrences').get().n,recurrence_occurrences:db.prepare('SELECT count(*) n FROM recurrence_occurrences').get().n,recurrence_events:db.prepare('SELECT count(*) n FROM recurrence_events').get().n,reminders:db.prepare('SELECT count(*) n FROM reminders').get().n,deadline_change_requests:db.prepare('SELECT count(*) n FROM deadline_change_requests').get().n,pending_deadline_change_requests:db.prepare("SELECT count(*) n FROM deadline_change_requests WHERE status='PENDING'").get().n,domain_bindings:db.prepare('SELECT count(*) n FROM task_domain_bindings').get().n}};
  }finally{try{contactsDb?.close();}catch{}try{db.close();}catch{}}
}

module.exports = { CREATE_CURRENT, migrate, openDb, openReadDb, healthSnapshot };