#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/production-control/plugin-registry-state.cjs"
TMP=$(mktemp -d /tmp/task-plugin-registry-state.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/openclaw.sqlite"
SNAP="$TMP/registry.json"
HOST=$(node "$ROOT/../../shared/runtime-contract/runtime-contract.mjs" openclaw-version "$ROOT/../../runtime-contract.json")
TASK_PLUGIN=$(node -e 'process.stdout.write(require(process.argv[1]).plugin.version)' "$ROOT/release.json")
CONTACTS_PLUGIN=$(node -e 'process.stdout.write(require(process.argv[1]).plugin.version)' "$ROOT/../../shared/contacts/release.json")

node - "$DB" "$HOST" "$TASK_PLUGIN" "$CONTACTS_PLUGIN" <<'NODE'
const {DatabaseSync}=require('node:sqlite');
const [host,task,contacts]=process.argv.slice(3);
const db=new DatabaseSync(process.argv[2]);
db.exec('CREATE TABLE config_machine_state(state_key TEXT NOT NULL PRIMARY KEY,value_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL) STRICT');
const wrapper={revision:111,index:{version:1,hostContractVersion:host,installRecords:{taskctl:{version:task},contacts:{version:contacts}},plugins:[{pluginId:'taskctl',packageVersion:task,enabled:true,installOwner:'taskctl',rootDir:'/task',origin:'global'},{pluginId:'contacts',packageVersion:contacts,enabled:true,installOwner:'contacts',rootDir:'/contacts',origin:'global'}]}};
db.prepare('INSERT INTO config_machine_state VALUES(?,?,?)').run('plugins.installedIndex',JSON.stringify(wrapper),111);
db.close();
NODE
node "$HELPER" snapshot "$DB" "$SNAP"
node "$HELPER" validate-snapshot "$SNAP"
node "$HELPER" verify-target "$DB" "$HOST" "$TASK_PLUGIN" "$CONTACTS_PLUGIN"
BEFORE=$(node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const r=db.prepare("SELECT value_json,updated_at_ms FROM config_machine_state WHERE state_key='plugins.installedIndex'").get();process.stdout.write(JSON.stringify(r));}finally{db.close();}
NODE
)
node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2]);try{db.prepare("UPDATE config_machine_state SET value_json=?,updated_at_ms=? WHERE state_key='plugins.installedIndex'").run('{"broken":true}',999);}finally{db.close();}
NODE
node "$HELPER" restore "$DB" "$SNAP"
AFTER=$(node - "$DB" <<'NODE'
const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[2],{readOnly:true});try{const r=db.prepare("SELECT value_json,updated_at_ms FROM config_machine_state WHERE state_key='plugins.installedIndex'").get();process.stdout.write(JSON.stringify(r));}finally{db.close();}
NODE
)
[ "$BEFORE" = "$AFTER" ]

BAD="$TMP/invalid-absent.json"
printf '{"format":"openclaw-plugin-registry-recovery-v1","row_present":false}\n' > "$BAD"
set +e
node "$HELPER" validate-snapshot "$BAD" >/dev/null 2>&1
RC=$?
set -e
[ "$RC" -eq 2 ]

echo TASK_PLUGIN_REGISTRY_STATE_PASS
