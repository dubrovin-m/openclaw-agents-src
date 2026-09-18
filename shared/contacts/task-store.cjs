'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contacts = require('./core.cjs');

const TASK_SCHEMA_VERSION = 7;
const PROD_CONTACTS_DB = path.join(os.homedir(), '.openclaw', 'data', 'contacts', 'contacts.sqlite3');

function contactsDbPath(){
  if(process.env.TASKCTL_ALLOW_DB_OVERRIDE==='1'){
    if(process.env.TASKCTL_CONTACTS_DB)return path.resolve(process.env.TASKCTL_CONTACTS_DB);
    if(process.env.TASKCTL_DB)return path.join(path.dirname(path.resolve(process.env.TASKCTL_DB)),'contacts.sqlite3');
  }
  return PROD_CONTACTS_DB;
}
function attachContacts(db, dbPath=contactsDbPath(), options={}){
  const existing=db.prepare('PRAGMA database_list').all().find(x=>x.name==='contacts');
  if(existing)return dbPath;
  const create=options.create===true;
  if(!create&&!fs.existsSync(dbPath))throw new Error('Contacts database is missing');
  const dir=path.dirname(dbPath);if(create)fs.mkdirSync(dir,{recursive:true,mode:0o700});try{fs.chmodSync(dir,0o700);}catch{}
  db.prepare('ATTACH DATABASE ? AS contacts').run(dbPath);
  try{fs.chmodSync(dbPath,0o600);}catch{}
  return dbPath;
}
function configureJournals(db){
  db.exec('PRAGMA main.journal_mode=DELETE; PRAGMA contacts.journal_mode=DELETE; PRAGMA main.synchronous=FULL; PRAGMA contacts.synchronous=FULL;');
}

const TASKS_V7 = "CREATE TABLE tasks_v7(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL CHECK(length(trim(title))>0), assignee_id INTEGER NOT NULL CHECK(assignee_id>0), status TEXT NOT NULL CHECK(status IN ('OPEN','DONE','CANCELLED')), due_date TEXT, due_time TEXT CHECK(due_time IS NULL OR (due_date IS NOT NULL AND length(due_time)=5 AND due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr(due_time,1,2) AS INTEGER)<=23)), created_at TEXT NOT NULL, completed_at TEXT, project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT, CHECK((status='DONE' AND completed_at IS NOT NULL) OR (status!='DONE' AND completed_at IS NULL))) STRICT;";
const RECURRENCES_V7 = "CREATE TABLE recurrences_v7(id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL CHECK(status IN ('ACTIVE','PAUSED','CANCELLED')), mode TEXT NOT NULL CHECK(mode IN ('CALENDAR','AFTER_COMPLETION')), title TEXT NOT NULL CHECK(length(trim(title))>0), assignee_id INTEGER NOT NULL CHECK(assignee_id>0), due_time TEXT CHECK(due_time IS NULL OR (length(due_time)=5 AND due_time GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr(due_time,1,2) AS INTEGER)<=23)), target_project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT, rule_json TEXT NOT NULL CHECK(length(trim(rule_json))>0), calendar_cursor_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancelled_at TEXT, CHECK((status='CANCELLED' AND cancelled_at IS NOT NULL) OR (status!='CANCELLED' AND cancelled_at IS NULL)), CHECK((mode='CALENDAR' AND calendar_cursor_date IS NOT NULL) OR (mode='AFTER_COMPLETION' AND calendar_cursor_date IS NULL))) STRICT;";

function validatePersonReferences(db){
  const ids=new Set();
  for(const row of db.prepare('SELECT DISTINCT assignee_id FROM tasks').all())ids.add(row.assignee_id);
  for(const row of db.prepare('SELECT DISTINCT assignee_id FROM recurrences').all())ids.add(row.assignee_id);
  for(const id of ids)if(!contacts.canonicalPerson(db,id,'contacts'))throw new Error(`Dangling Person reference P-${id}`);
}

function copyPeople(db){
  const people=db.prepare('SELECT * FROM people ORDER BY id').all();
  const self=people.filter(x=>x.display_name===contacts.SELF_NAME);
  if(self.length!==1)throw new Error(`Expected one canonical self Person before migration, found ${self.length}`);
  const insert=db.prepare("INSERT INTO contacts.people(id,display_name,organization,title,is_self,status,merged_into,created_at,updated_at) VALUES(?,?,NULL,NULL,?,'ACTIVE',NULL,?,?)");
  for(const row of people)insert.run(row.id,row.display_name,row.id===self[0].id?1:0,row.created_at,row.created_at);
  const aliasInsert=db.prepare('INSERT INTO contacts.person_aliases(person_id,alias,created_at) VALUES(?,?,?)');
  for(const row of db.prepare('SELECT pa.person_id,pa.alias,p.created_at FROM person_aliases pa JOIN people p ON p.id=pa.person_id ORDER BY pa.person_id,pa.alias').all())aliasInsert.run(row.person_id,row.alias,row.created_at);
}

function migrateV6ToV7(db, dbPath=contactsDbPath()){
  if(Number(db.prepare('PRAGMA main.user_version').get().user_version)!==6)throw new Error('Task schema 6 is required for Shared Contacts migration');
  const contactsExisted=fs.existsSync(dbPath);
  db.exec('PRAGMA foreign_keys=OFF; PRAGMA main.journal_mode=DELETE;');
  attachContacts(db,dbPath,{create:true});configureJournals(db);
  db.exec('BEGIN IMMEDIATE');
  try{
    contacts.ensureSchema(db,'contacts');
    const existing=Number(db.prepare('SELECT count(*) n FROM contacts.people').get().n);
    if(existing!==0)throw new Error('Contacts target must be empty before Task Person migration');
    copyPeople(db);
    if(process.env.TASKCTL_ALLOW_DB_OVERRIDE==='1'&&process.env.TASKCTL_TEST_CONTACTS_MIGRATION_FAULT==='after-contacts-copy')throw new Error('Synthetic Shared Contacts migration fault after contacts copy');
    db.exec(TASKS_V7);db.exec(RECURRENCES_V7);
    db.exec('INSERT INTO tasks_v7 SELECT * FROM tasks; INSERT INTO recurrences_v7 SELECT * FROM recurrences;');
    db.exec('DROP TABLE tasks; ALTER TABLE tasks_v7 RENAME TO tasks; DROP TABLE recurrences; ALTER TABLE recurrences_v7 RENAME TO recurrences;');
    db.exec('DROP TABLE person_aliases; DROP TABLE people;');
    if(process.env.TASKCTL_ALLOW_DB_OVERRIDE==='1'&&process.env.TASKCTL_TEST_CONTACTS_MIGRATION_FAULT==='after-task-rebuild')throw new Error('Synthetic Shared Contacts migration fault after Task rebuild');
    db.exec('CREATE INDEX idx_tasks_status_due ON tasks(status,due_date,due_time); CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id,status); CREATE INDEX idx_tasks_project_status ON tasks(project_id,status,id);');
    db.exec('CREATE INDEX idx_recurrences_status_mode ON recurrences(status,mode,id); CREATE INDEX idx_recurrences_project_status ON recurrences(target_project_id,status,id);');
    db.exec(`PRAGMA main.user_version=${TASK_SCHEMA_VERSION}`);
    const integrity=contacts.integrity(db,'contacts');if(!integrity.ok)throw new Error(`Contacts integrity failed: ${integrity.errors.join('; ')}`);
    validatePersonReferences(db);
    if(db.prepare('PRAGMA main.foreign_key_check').all().length)throw new Error('Task foreign-key check failed during migration');
    if(db.prepare('PRAGMA contacts.foreign_key_check').all().length)throw new Error('Contacts foreign-key check failed during migration');
    db.exec('COMMIT');
  }catch(error){
    try{db.exec('ROLLBACK');}catch{}
    try{db.exec('PRAGMA foreign_keys=ON;')}catch{}
    if(!contactsExisted){try{db.exec('DETACH DATABASE contacts');}catch{}try{fs.rmSync(dbPath,{force:true});fs.rmSync(`${dbPath}-journal`,{force:true});}catch{}}
    throw error;
  }
  db.exec('PRAGMA foreign_keys=ON;');
  return {task_schema:TASK_SCHEMA_VERSION,contacts_schema:contacts.CONTACT_SCHEMA_VERSION,contacts_db:dbPath};
}

function prepareV7(db, dbPath=contactsDbPath()){
  attachContacts(db,dbPath);configureJournals(db);
  contacts.requireSchema(db,'contacts');contacts.ensureSingleSelf(db,'contacts');
  const integrity=contacts.integrity(db,'contacts');if(!integrity.ok)throw new Error(`Contacts integrity failed: ${integrity.errors.join('; ')}`);
  validatePersonReferences(db);
  return dbPath;
}

function canonicalPersonSql(sourceAlias='ps',canonicalAlias='p'){
  return `JOIN contacts.people ${sourceAlias} ON ${sourceAlias}.id=t.assignee_id JOIN contacts.people ${canonicalAlias} ON ${canonicalAlias}.id=CASE WHEN ${sourceAlias}.status='MERGED' THEN ${sourceAlias}.merged_into ELSE ${sourceAlias}.id END`;
}

module.exports={TASK_SCHEMA_VERSION,PROD_CONTACTS_DB,contactsDbPath,attachContacts,configureJournals,migrateV6ToV7,prepareV7,validatePersonReferences,canonicalPersonSql};
