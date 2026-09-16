#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/production-control/plugin-registry-state.cjs"
TMP=$(mktemp -d /tmp/task-plugin-registry-state.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/openclaw.sqlite"
SNAP="$TMP/registry.json"
node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[2]);
db.exec('CREATE TABLE config_machine_state(state_key TEXT NOT NULL PRIMARY KEY,value_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL) STRICT');
const wrapper={revision:111,index:{version:1,warning:'generated',hostContractVersion:'2026.8.2',compatRegistryVersion:'x',migrationVersion:1,policyHash:'p',generatedAtMs:111,installRecords:{contacts:{version:'0.1.0'},taskctl:{version:'0.4.21'}},plugins:[{pluginId:'taskctl',packageVersion:'0.4.20',enabled:true,rootDir:'/x',origin:'global'}],diagnostics:[]}};
db.prepare('INSERT INTO config_machine_state VALUES(?,?,?)').run('plugins.installedIndex',JSON.stringify(wrapper),111);db.close();
NODE
node "$HELPER" snapshot "$DB" "$SNAP"
BEFORE=$(node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});const r=db.prepare("SELECT value_json,updated_at_ms FROM config_machine_state WHERE state_key='plugins.installedIndex'").get();process.stdout.write(JSON.stringify(r));db.close();
NODE
)
node "$HELPER" normalize-initial "$DB" 2026.8.2 0.4.20
node "$HELPER" verify-normalized "$DB" 2026.8.2 0.4.20
node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2]);const row=db.prepare("SELECT value_json FROM config_machine_state WHERE state_key='plugins.installedIndex'").get(),w=JSON.parse(row.value_json),now=Date.now();w.revision=now;w.index.generatedAtMs=now;w.index.installRecords.contacts={version:'0.1.1'};w.index.installRecords.taskctl={version:'0.4.21'};w.index.plugins=[{pluginId:'taskctl',packageVersion:'0.4.21',enabled:true,installOwner:'taskctl',rootDir:'/task',origin:'global'},{pluginId:'contacts',packageVersion:'0.1.1',enabled:true,installOwner:'contacts',rootDir:'/contacts',origin:'global'}];db.prepare("UPDATE config_machine_state SET value_json=?,updated_at_ms=? WHERE state_key='plugins.installedIndex'").run(JSON.stringify(w),now);db.close();
NODE
node "$HELPER" verify-target "$DB" 2026.8.2 0.4.21 0.1.1
node "$HELPER" restore "$DB" "$SNAP"
AFTER=$(node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});const r=db.prepare("SELECT value_json,updated_at_ms FROM config_machine_state WHERE state_key='plugins.installedIndex'").get();process.stdout.write(JSON.stringify(r));db.close();
NODE
)
[ "$BEFORE" = "$AFTER" ]
# Row-absent snapshot must delete a later row again.
DB2="$TMP/absent.sqlite"; SNAP2="$TMP/absent.json"
node - "$DB2" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2]);db.exec('CREATE TABLE config_machine_state(state_key TEXT NOT NULL PRIMARY KEY,value_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL) STRICT');db.close();
NODE
node "$HELPER" snapshot "$DB2" "$SNAP2"
node - "$DB2" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2]);const w={revision:1,index:{version:1,hostContractVersion:'2026.8.2',installRecords:{},plugins:[]}};db.prepare('INSERT INTO config_machine_state VALUES(?,?,?)').run('plugins.installedIndex',JSON.stringify(w),1);db.close();
NODE
node "$HELPER" restore "$DB2" "$SNAP2"
node - "$DB2" <<'NODE'
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2],{readOnly:true});if(db.prepare("SELECT 1 FROM config_machine_state WHERE state_key='plugins.installedIndex'").get())process.exit(1);db.close();
NODE
echo TASK_PLUGIN_REGISTRY_STATE_PASS
