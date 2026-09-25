#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const KEY='plugins.installedIndex';
const FORMAT='openclaw-plugin-registry-recovery-v1';
function fail(message){throw new Error(message)}
function ensureParent(file){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})}
function tableColumns(db){
  const table=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='config_machine_state'").get();
  if(!table) return null;
  const cols=db.prepare("PRAGMA table_info('config_machine_state')").all().map(x=>x.name).sort();
  if(cols.join(',')!=='state_key,updated_at_ms,value_json') fail('unexpected config_machine_state schema');
  return cols;
}
function parseWrapper(value){
  let wrapper; try{wrapper=JSON.parse(value)}catch{fail('plugin registry row is not JSON')}
  const index=wrapper?.index;
  if(!Number.isSafeInteger(wrapper?.revision)||!index||index.version!==1||typeof index.hostContractVersion!=='string'||!index.installRecords||typeof index.installRecords!=='object'||Array.isArray(index.installRecords)||!Array.isArray(index.plugins)) fail('unsupported plugin registry row format');
  return wrapper;
}
function readRow(db){
  if(!tableColumns(db)) return null;
  const row=db.prepare('SELECT value_json,updated_at_ms FROM config_machine_state WHERE state_key=?').get(KEY);
  if(!row) return null;
  parseWrapper(row.value_json);
  return row;
}
function snapshot(dbPath,outPath){
  if(!fs.existsSync(dbPath)) fail('OpenClaw state database missing during registry snapshot');
  const db=new DatabaseSync(dbPath,{readOnly:true});
  let row;
  try{row=readRow(db)}finally{db.close()}
  if(!row) fail('plugin registry row missing during recovery snapshot');
  const out={format:FORMAT,row_present:true,value_json:row.value_json,updated_at_ms:Number(row.updated_at_ms)};
  ensureParent(outPath); fs.writeFileSync(outPath,JSON.stringify(out,null,2)+'\n',{mode:0o600}); fs.chmodSync(outPath,0o600);
}
function readSnapshot(file){
  const x=JSON.parse(fs.readFileSync(file,'utf8'));
  if(x?.format!==FORMAT||x.row_present!==true||typeof x.value_json!=='string'||!Number.isSafeInteger(x.updated_at_ms)) fail('invalid plugin registry recovery snapshot');
  parseWrapper(x.value_json);
  return x;
}
function validateSnapshot(file){readSnapshot(file)}
function restore(dbPath,snapshotPath){
  const snap=readSnapshot(snapshotPath);
  if(!fs.existsSync(dbPath)) fail('OpenClaw state database missing during registry restore');
  const db=new DatabaseSync(dbPath); try{
    if(!tableColumns(db)) fail('config_machine_state missing during registry restore');
    db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare('INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,?) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms').run(KEY,snap.value_json,snap.updated_at_ms);
      db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK')}catch{};throw e}
    const actual=readRow(db);
    if(!actual||actual.value_json!==snap.value_json||Number(actual.updated_at_ms)!==snap.updated_at_ms)fail('plugin registry row did not restore exactly');
  } finally{db.close()}
}
function verifyTarget(dbPath,hostVersion,taskctlVersion,contactsVersion){
  const db=new DatabaseSync(dbPath,{readOnly:true}); try{
    const row=readRow(db); if(!row) fail('target plugin registry row missing'); const i=parseWrapper(row.value_json).index;
    if(i.hostContractVersion!==hostVersion) fail('target registry host mismatch');
    for(const [id,version] of [['taskctl',taskctlVersion],['contacts',contactsVersion]]){
      const rec=i.installRecords[id]; if(!rec||rec.version!==version) fail(`${id} target install record mismatch`);
      const rows=i.plugins.filter(p=>p?.pluginId===id&&p?.enabled===true); if(rows.length!==1||rows[0].packageVersion!==version||rows[0].installOwner!==id) fail(`${id} target registry child mismatch`);
    }
  } finally{db.close()}
}
const [cmd,...args]=process.argv.slice(2);
try{
  if(cmd==='snapshot'&&args.length===2)snapshot(...args);
  else if(cmd==='validate-snapshot'&&args.length===1)validateSnapshot(...args);
  else if(cmd==='restore'&&args.length===2)restore(...args);
  else if(cmd==='verify-target'&&args.length===4)verifyTarget(...args);
  else fail('usage: plugin-registry-state.cjs snapshot|validate-snapshot|restore|verify-target ...');
}catch(e){console.error(e?.message||String(e));process.exit(2)}
