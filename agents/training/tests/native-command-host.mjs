#!/usr/bin/env node
// Synthetic native-command authorization regression for pinned OpenClaw.
// Exercises its actual external plugin registry and command executor: the
// direct handler-only tests did not detect the production activation failure.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import plugin from '../plugin/dist/plugin.js';
import {proposeProgramChange} from '../plugin/dist/domain.js';
import {openTrainingStore} from '../plugin/dist/store.js';

const root=path.resolve(import.meta.dirname,'..');
const fromPlugin=createRequire(path.join(root,'plugin/package.json'));
const sdkPath=fromPlugin.resolve('openclaw/plugin-sdk/tool-plugin');
const hostPackageDir=path.resolve(path.dirname(sdkPath),'../..');
const host=fromPlugin(path.join(hostPackageDir,'package.json'));
assert.equal(host.version,'2026.9.8','Authorization tests require the exact qualified host');

const dist=path.join(hostPackageDir,'dist');
async function hostModule(prefix,exportName,signature){
  const files=fs.readdirSync(dist).filter(name=>name.startsWith(prefix)&&name.endsWith('.mjs'));
  const implementations=files.filter(name=>fs.readFileSync(path.join(dist,name),'utf8').includes(signature));
  assert.equal(implementations.length,1,'Exactly one pinned host implementation required: '+prefix);
  const module=await import(pathToFileURL(path.join(dist,implementations[0])).href);
  assert.equal(typeof module[exportName],'function','Missing host export: '+prefix);
  return module[exportName];
}
const execute=await hostModule('plugin-command-execution-','t','async function executeRegisteredPluginCommand(');
const register=await hostModule('command-registration-','r','function registerPluginCommandInRegistry(');
const list=await hostModule('plugin-command-registry-','t','function listRegisteredPluginCommands(');

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'training-native-owner-host.'));
const dbFile=path.join(temp,'synthetic.sqlite3');
const open=()=>openTrainingStore(dbFile);
try{
  // Synthetic fixture only. No Telegram token, owner ID, provider credentials,
  // or production Training Store is read or retained in this test.
  execFileSync(process.execPath,[
    path.join(root,'migration/import.mjs'),dbFile,
    path.join(root,'migration/fixtures/synthetic.json'),
  ],{stdio:'pipe',maxBuffer:1024*1024});
  const db=open();
  const template=db.prepare('SELECT template_exercise_id,target_sets FROM template_exercises LIMIT 1').get();
  assert.ok(template);
  const proposal=proposeProgramChange(db,{
    change_type:'UPDATE_EXERCISE_TARGETS',
    proposal:{template_exercise_id:template.template_exercise_id,target_sets:template.target_sets+1},
    rationale:'synthetic owner-native auth test',created_by:'USER',
  });
  db.close();

  const collected=[];
  plugin.register({
    pluginConfig:{databasePath:dbFile},
    registerTool(){},
    registerCommand(command){collected.push(command);},
  });
  assert.deepEqual(collected.map(c=>c.name),['trainingapprove','trainingload']);
  const registry={commands:[],channels:[],plugins:[]};
  for(const command of collected){
    assert.equal(command.requireAuth,true);
    assert.deepEqual(command.channels,['telegram']);
    assert.deepEqual(command.requiredScopes,['operator.read'],
      'Owner status must use external command scope, not bundled plugin trust');
    assert.equal(command.exposeSenderIsOwner,true);
    const r=register(registry,'training',command,{
      pluginName:'Training',allowOwnerStatusExposure:false,
    });
    assert.equal(r.ok,true,r.error);
  }
  const commands=list(registry);
  for(const command of commands){
    assert.equal(command.trustedOwnerStatusExposure,undefined,
      'External Training commands must not gain bundled-plugin trust');
  }

  const digest=()=>{
    const db=open();
    try{return crypto.createHash('sha256').update(db.serialize()).digest('hex');}
    finally{db.close();}
  };
  const versionCount=()=>{
    const db=open();
    try{return db.prepare('SELECT count(*) n FROM program_versions').get().n;}
    finally{db.close();}
  };
  const invoke=async(name,args,options={})=>{
    const {authorized=true,owner=true,scopes,assertCurrent=()=>{}}=options;
    const command=commands.find(c=>c.name===name);
    assert.ok(command);
    return execute(registry,{
      command,args,channel:'telegram',channelId:'telegram',
      senderId:'synthetic-sender',isAuthorizedSender:authorized,
      senderIsOwner:owner,assertOwnerCurrent:assertCurrent,
      ...(scopes?{gatewayClientScopes:scopes}:{}),
      agentId:'training',commandBody:'/'+name+' '+args,config:{},
    });
  };
  const args=proposal.proposal_id+' '+proposal.approval_fingerprint;
  const before=digest();
  assert.equal(versionCount(),1);

  const unauth=await invoke('trainingapprove',args,{authorized:false,owner:false});
  assert.match(unauth.text,/requires authorization/i);
  const nonowner=await invoke('trainingapprove',args,{owner:false});
  assert.match(nonowner.text,/requires gateway scope/i);
  // A scoped but non-owner internal client must still fail owner assertion.
  const scopedNonowner=await invoke('trainingapprove',args,{
    owner:false,scopes:['operator.read'],
  });
  assert.match(scopedNonowner.text,/owner authority/i);
  const stale=await invoke('trainingapprove',args,{
    assertCurrent(){throw new Error('synthetic stale owner assertion');},
  });
  assert.match(stale.text,/Command failed/i,
    'Host must reject a stale owner before any Training mutation');
  assert.equal(digest(),before,'Unauthorized or stale invocations must not write');
  assert.equal(versionCount(),1);

  // Admitted owner must reach domain validation; invalid identity/fingerprint
  // may not mutate anything, even after passing the host owner check.
  const wrong=await invoke('trainingapprove',proposal.proposal_id+' 0000000000000000');
  assert.match(wrong.text,/rejected/i);
  assert.doesNotMatch(wrong.text,/owner authority/i);
  const wrongLoad=await invoke('trainingload','nonexistent-exercise 700');
  assert.match(wrongLoad.text,/rejected/i);
  assert.doesNotMatch(wrongLoad.text,/owner authority/i);
  assert.equal(digest(),before);

  let assertions=0;
  const accepted=await invoke('trainingapprove',args,{
    assertCurrent(){assertions++;},
  });
  assert.match(accepted.text,/approved and applied/i);
  assert.ok(assertions>=2,'Host and plugin must independently revalidate owner');
  assert.equal(versionCount(),2);
  const replay=await invoke('trainingapprove',args);
  assert.match(replay.text,/already applied/i);
  assert.equal(versionCount(),2);
  console.log('TRAINING_NATIVE_OWNER_HOST_PASS');
}finally{
  fs.rmSync(temp,{recursive:true,force:true});
}
