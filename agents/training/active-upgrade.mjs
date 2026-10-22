#!/usr/bin/env node
/**
 * Bounded Training ACTIVE predecessor -> frozen target upgrade.
 * This is an implementation-owned exceptional runner, NOT a production
 * authorization interface and NOT a replacement for the stage-only deployer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Config snapshots may contain provider-managed secrets; never create world-readable temporaries.
process.umask(0o077);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hashFile = (p) => sha(fs.readFileSync(p));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const die = (msg) => { throw new Error(msg); };
const argv = process.argv.slice(2);
let testRoot = null;
if (argv[0] === '--test-root') testRoot = argv.splice(0,2)[1];
const mode = argv.shift();
if (!['--preflight','--apply'].includes(mode)) die('Usage: active-upgrade.mjs [--test-root /safe/absolute/path] --preflight|--apply [--source-sha SHA]');
let approvedSha = null;
if (argv.length) {
  if (argv[0] !== '--source-sha' || argv.length !== 2 || !/^[a-f0-9]{40}$/.test(argv[1])) die('Invalid exact --source-sha');
  approvedSha = argv[1];
}
if (mode === '--apply' && !approvedSha) die('Exact --source-sha is mandatory for apply (authorization is external)');
const home = testRoot ? path.join(path.resolve(testRoot),'home') : os.homedir();
if (testRoot) {
  const real = fs.realpathSync(testRoot);
  const actualHome = fs.realpathSync(os.homedir());
  if (real === '/' || real === actualHome || real === path.join(actualHome,'.openclaw') ||
      real.startsWith(path.join(actualHome,'.openclaw')+path.sep) ||
      real.startsWith(path.join(actualHome,'.local')+path.sep)) die('Unsafe test root');
  // A safe-looking test root is not a sandbox if its nested paths escape
  // through symlinks. Refuse before executing any host CLI operation.
  for (const name of ['home','state']) {
    const child=path.join(path.resolve(testRoot),name);
    const stat=fs.lstatSync(child);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        fs.realpathSync(child)!==path.join(real,name)) die('Unsafe test root child: '+name);
  }
}
const state = testRoot ? path.join(path.resolve(testRoot),'state') : path.join(home,'.openclaw');
const configFile = path.join(state,'openclaw.json');
const workspace = path.join(state,'workspace-training');
const agentsFile = path.join(workspace,'AGENTS.md');
const entryFile = path.join(state,'extensions/training/dist/plugin.js');
const dbFile = path.join(state,'data/training/training.sqlite3');
const releaseFile = path.join(here,'release.json');
const targetToolsFile = path.join(here,'config/training-tools.json');
const targetAgentsFile = path.join(here,'workspace/AGENTS.md');
const helper = path.join(here,'deploy-support.mjs');
const host = process.env.OPENCLAW_BIN || 'openclaw';
const env = testRoot ? {
  ...process.env, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configFile,
} : process.env;
const exec = (bin, args, input) => execFileSync(bin,args,{
  env, encoding:'utf8', input, maxBuffer:4*1024*1024,
  stdio: ['pipe','pipe','pipe'], timeout:120000
});
const oc = (...args) => exec(host,args);
const command = (...args) => exec('git',args);
const sourceSha = command('-C',root,'rev-parse','HEAD').trim();
if (!testRoot && command('-C',root,'status','--porcelain','--untracked-files=all').trim()) die('Frozen source checkout is dirty');
if (!/^[a-f0-9]{40}$/.test(sourceSha) || (approvedSha && sourceSha !== approvedSha)) die('Source revision does not match approved identity');
const hostVersion = oc('--version').match(/[0-9]+\.[0-9]+\.[0-9]+/)?.[0];
if (!hostVersion) die('OpenClaw host version unavailable');
exec('node',[helper,'release-env',root,releaseFile,hostVersion]);
const release = readJson(releaseFile);
const predecessor = release.predecessor;
const tools = readJson(targetToolsFile);
const historicalTools = JSON.parse(command('-C',root,'show',predecessor.source_revision+':agents/training/config/training-tools.json'));
const checkRegular = (p) => {
  const stat = fs.lstatSync(p);
  if (!stat.isFile() || stat.isSymbolicLink()) die('Unsafe runtime file');
};
function checksDb() {
  checkRegular(dbFile);
  const db = new DatabaseSync(dbFile,{readOnly:true});
  try {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== release.generation.sqlite_schema) die('Training schema mismatch');
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') die('Training SQLite integrity failed');
    if (db.prepare('PRAGMA foreign_key_check').all().length) die('Training foreign key violations');
    if (db.prepare("SELECT COUNT(*) n FROM training_sessions WHERE status IN ('ACTIVE','PAUSED')").get().n !== 0) die('Training has an active or paused session');
  } finally { db.close(); }
}
const agentRecords = (c) => {
  const e = c?.agents?.entries;
  if (Array.isArray(e)) return e;
  if (e && typeof e==='object') return Object.entries(e).map(([id,v])=>({id,...v}));
  return [];
};
const trainingRecord = (c) => {
  const m = agentRecords(c).filter(x=>x?.id==='training');
  if (m.length !== 1) die('Training agent is not uniquely registered');
  return m[0];
};
function ownerRoute(c) {
  const b = Array.isArray(c.bindings) ? c.bindings.filter(x=>x?.agentId==='training') : [];
  const t = c?.channels?.telegram?.accounts?.training;
  if (b.length !== 1 || b[0]?.match?.channel!=='telegram' || b[0]?.match?.accountId!=='training' ||
      t?.enabled!==true || t?.dmPolicy!=='allowlist' ||
      !Array.isArray(t?.allowFrom) || t.allowFrom.length!==1 ||
      t?.groupPolicy!=='disabled') die('Training owner-only Telegram route mismatch');
  return { binding:b[0], account:t };
}
function assertPlugin(version, runtimeHash) {
  const p = JSON.parse(oc('plugins','list','--json')).plugins?.filter(x=>x?.id==='training') ?? [];
  if (p.length!==1 || p[0].version!==version || p[0].enabled!==true || p[0].status!=='loaded') die('Training plugin runtime identity mismatch');
  checkRegular(entryFile);
  if (hashFile(entryFile)!==runtimeHash) die('Training compiled plugin hash mismatch');
}
function inspect(expected, expectedTools) {
  checkRegular(configFile);checkRegular(agentsFile);
  const c=readJson(configFile);
  if (!same(trainingRecord(c).tools,expectedTools)) die('Training model-facing tools policy mismatch');
  if (c?.plugins?.entries?.training?.enabled!==true ||
      c.plugins.entries.training.config?.databasePath!==dbFile ||
      !Array.isArray(c.plugins.allow) || c.plugins.allow.filter(x=>x==='training').length!==1) die('Training plugin enablement/config mismatch');
  ownerRoute(c);checksDb();
  if (expected==='predecessor') {
    if (hashFile(agentsFile)!==predecessor.workspace_sha256['AGENTS.md']) die('Training predecessor AGENTS instructions have drifted');
    assertPlugin(predecessor.plugin.version,predecessor.plugin.runtime_entry_sha256);
  } else {
    if (hashFile(agentsFile)!==release.source.workspace_sha256['AGENTS.md']) die('Target Training AGENTS instructions mismatch');
    assertPlugin(release.plugin.version,release.plugin.runtime_entry_sha256);
  }
  return c;
}
function gatewayReady() {
  if (testRoot) return;
  oc('gateway','status','--deep','--require-rpc');
}
// Replacement of an active plugin on disk does not prove that the long-running
// Gateway has adopted that generation. A supported in-process reload is required.
function gatewayReload() {
  if (testRoot) return; // separately covered by disposable live-Gateway E2E
  const response = JSON.parse(oc('plugins','reload','training','--wait','--json'));
  const applied = response?.runtime;
  if (response?.restartRequired !== false ||
      !Array.isArray(response?.pluginIds) || !response.pluginIds.includes('training') ||
      !applied || typeof applied.operationId !== 'string' || !applied.operationId ||
      !Number.isSafeInteger(applied.generation) || applied.generation < 1 ||
      !Array.isArray(applied.pluginIds) || !applied.pluginIds.includes('training')) {
    die('Training Gateway reload did not return an accepted applied generation receipt');
  }
  gatewayReady();
}
const old = inspect('predecessor',historicalTools);
gatewayReady();
if (mode==='--preflight') {
  process.stdout.write('TRAINING_ACTIVE_UPGRADE_PREFLIGHT_PASS source='+sourceSha+' target='+release.plugin.version+'\n');
  process.exit(0);
}
// The private recovery set is local to the runtime. It is NOT an independent backup.
const recoveryBase = path.join(state,'.training-active-upgrade-recovery');
function ensurePrivateDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir,{mode:0o700});
  const stat=fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)!==0 ||
      (typeof process.getuid==='function' && stat.uid!==process.getuid())) die('Unsafe private recovery directory');
}
ensurePrivateDirectory(state);
ensurePrivateDirectory(path.dirname(recoveryBase));
ensurePrivateDirectory(recoveryBase);
const lock = path.join(recoveryBase,'.active.lock');
fs.mkdirSync(lock,{mode:0o700}); // surviving crash refuses later mutation
const recoveryDir = path.join(recoveryBase,sourceSha.slice(0,12)+'-'+process.pid);
let mutated = false;
let done = false;
let backupCreated = false;
let externalMutationUncertain = false;
function invokeAcceptedMutation(fn) {
  externalMutationUncertain = true;
  const result = fn();
  externalMutationUncertain = false;
  return result;
}
const oldDbHash = hashFile(dbFile);
const oldIdentityHash = hashFile(path.join(workspace,'IDENTITY.md'));
const resultFile = path.join(recoveryDir,'result.json');
function writeResult(status,stage,message) {
  fs.writeFileSync(resultFile,JSON.stringify({
    format:'training-active-upgrade-result-v1',status,stage,message,
    source_revision:sourceSha,predecessor:predecessor.plugin.version,
    target:release.plugin.version,mutation_started:mutated,
  },null,2)+'\n',{mode:0o600});
}
function toolsPatch(base,policy) {
  const entries=structuredClone(base.agents.entries);
  if (Array.isArray(entries)) {
    const i=entries.findIndex(x=>x?.id==='training');
    if (i<0) die('Training agent missing');
    entries[i].tools=policy;
  } else {
    if (!entries?.training) die('Training agent missing');
    entries.training.tools=policy;
  }
  return JSON.stringify({agents:{entries}});
}
function preserveBoundaries(before,after) {
  if (!same(ownerRoute(before),ownerRoute(after))) die('Training Telegram owner route drift');
  const a=structuredClone(before.agents.entries);
  const b=structuredClone(after.agents.entries);
  const clearTools=(entries)=>{
    if (Array.isArray(entries)) entries.find(x=>x?.id==='training').tools=null;
    else entries.training.tools=null;
  };
  clearTools(a);clearTools(b);
  if (!same(a,b)) die('Another agent attribute changed during Training upgrade');
  if (hashFile(path.join(workspace,'IDENTITY.md'))!==oldIdentityHash) die('Training runtime identity was changed');
  if (hashFile(dbFile)!==oldDbHash) die('Training Store changed during upgrade');
}
function atomicCopy(source,dest) {
  const tmp=dest+'.training-active-upgrade-'+process.pid;
  fs.copyFileSync(source,tmp);fs.chmodSync(tmp,0o600);
  fs.renameSync(tmp,dest);
}
try {
  // Lock acquired: re-read and fail closed before any production mutation.
  inspect('predecessor',historicalTools);
  gatewayReady();
  fs.mkdirSync(recoveryDir,{mode:0o700});
  atomicCopy(configFile,path.join(recoveryDir,'config.before'));
  atomicCopy(agentsFile,path.join(recoveryDir,'AGENTS.before'));
  backupCreated=true;
  writeResult('IN_PROGRESS','PREFLIGHT','Backup staged; upgrade not yet started');
  mutated=true;
  invokeAcceptedMutation(() => oc('plugins','install','--force','--no-enable','--accept-capabilities',path.join(here,release.plugin.artifact)));
  if (testRoot && process.env.TRAINING_ACTIVE_UPGRADE_TEST_UNKNOWN_STAGE === 'after-install') {
    externalMutationUncertain = true; // synthetic lost acceptance response
    die('Synthetic unproven plugin-install outcome');
  }
  assertPlugin(release.plugin.version,release.plugin.runtime_entry_sha256);
  invokeAcceptedMutation(() => exec(host,['config','patch','--stdin'],toolsPatch(old,tools)+'\n'));
  oc('config','validate');
  if (testRoot && process.env.TRAINING_ACTIVE_UPGRADE_TEST_FAIL_STAGE === 'after-config') die('Synthetic after-config failure');
  atomicCopy(targetAgentsFile,agentsFile);
  if (testRoot && process.env.TRAINING_ACTIVE_UPGRADE_TEST_FAIL_STAGE === 'after-workspace') die('Synthetic after-workspace failure');
  const after=inspect('target',tools);
  preserveBoundaries(old,after);
  invokeAcceptedMutation(() => gatewayReload());
  writeResult('SUCCESS','COMPLETE','Training 0.1.7 active with owner-only tools and preserved Store');
  done=true;
  // Config backup contains possible secrets; do not retain after proven success.
  fs.rmSync(path.join(recoveryDir,'config.before'));
  fs.rmSync(path.join(recoveryDir,'AGENTS.before'));
  fs.rmdirSync(lock);
  process.stdout.write('TRAINING_ACTIVE_UPGRADE_PASS source='+sourceSha+' target='+release.plugin.version+'\n');
} catch(error) {
  // A CLI failure after an externally admitted mutation may be an unknown
  // outcome; never race it by starting an automatic compensating mutation.
  let recoveryError=externalMutationUncertain ? new Error('External mutation outcome unproven') : null;
  if (backupCreated && mutated && !externalMutationUncertain) {
    try {
      oc('plugins','install','--force','--no-enable','--accept-capabilities',path.join(here,predecessor.plugin.artifact));
      exec(host,['config','patch','--stdin'],toolsPatch(readJson(path.join(recoveryDir,'config.before')),historicalTools)+'\n');
      atomicCopy(path.join(recoveryDir,'AGENTS.before'),agentsFile);
      const reverted=inspect('predecessor',historicalTools);
      preserveBoundaries(old,reverted);
      gatewayReload();
    } catch(e) { recoveryError=e; }
  }
  const result = recoveryError?'RECOVERY_REQUIRED':mutated?'ROLLED_BACK':'BLOCKED_PRE_MUTATION';
  if (backupCreated) writeResult(result, recoveryError?'RECOVERY':mutated?'APPLY_FAILURE':'PREFLIGHT', recoveryError?'Manual reconciliation required':mutated?'Original Training release restored':'No production mutation started');
  if (!recoveryError) {
    fs.rmSync(lock,{recursive:true,force:true});
    if (backupCreated) {
      fs.rmSync(path.join(recoveryDir,'config.before'),{force:true});
      fs.rmSync(path.join(recoveryDir,'AGENTS.before'),{force:true});
    }
  }
  process.stderr.write('TRAINING_ACTIVE_UPGRADE_'+(recoveryError?'RECOVERY_REQUIRED':mutated?'FAILED_ROLLED_BACK':'BLOCKED_PRE_MUTATION')+'\n');
  process.exitCode=2;
}
