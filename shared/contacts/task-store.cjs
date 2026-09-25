'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contacts = require('./core.cjs');

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

function validatePersonReferences(db){
  const ids=new Set();
  for(const row of db.prepare('SELECT DISTINCT assignee_id FROM tasks').all())ids.add(row.assignee_id);
  for(const row of db.prepare('SELECT DISTINCT assignee_id FROM recurrences').all())ids.add(row.assignee_id);
  for(const id of ids)if(!contacts.canonicalPerson(db,id,'contacts'))throw new Error(`Dangling Person reference P-${id}`);
}

function prepareCurrent(db, dbPath=contactsDbPath()){
  attachContacts(db,dbPath);configureJournals(db);
  contacts.requireSchema(db,'contacts');contacts.ensureSingleSelf(db,'contacts');
  const integrity=contacts.integrity(db,'contacts');if(!integrity.ok)throw new Error(`Contacts integrity failed: ${integrity.errors.join('; ')}`);
  validatePersonReferences(db);
  return dbPath;
}

function canonicalPersonSql(sourceAlias='ps',canonicalAlias='p'){
  return `JOIN contacts.people ${sourceAlias} ON ${sourceAlias}.id=t.assignee_id JOIN contacts.people ${canonicalAlias} ON ${canonicalAlias}.id=CASE WHEN ${sourceAlias}.status='MERGED' THEN ${sourceAlias}.merged_into ELSE ${sourceAlias}.id END`;
}

module.exports={PROD_CONTACTS_DB,contactsDbPath,attachContacts,configureJournals,prepareCurrent,validatePersonReferences,canonicalPersonSql};
