import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(root,'../..');
const releasePath=path.join(root,'release.json');
const release=JSON.parse(fs.readFileSync(releasePath,'utf8'));
const taskRelease=JSON.parse(fs.readFileSync(path.join(repo,'agents/tasks/release.json'),'utf8'));
const sha=(p)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fail=(m)=>{throw new Error(m);};
const shaRe=/^[0-9a-f]{64}$/;

if(release?.format!=='shared-contacts-release-v1')fail('unsupported Shared Contacts release format');
const from=release?.from;
if(!from||!/^[0-9a-f]{40}$/.test(from.source_revision||'')||!/^0\.1\.\d+$/.test(from.implementation_version||'')||!Number.isSafeInteger(from.sqlite_schema)||from.sqlite_schema<1||!/^0\.1\.\d+$/.test(from.plugin_version||'')||!shaRe.test(from.release_sha256||''))fail('invalid Shared Contacts predecessor metadata');
const predBytes=execFileSync('git',['-C',repo,'show',from.source_revision+':shared/contacts/release.json']);
if(crypto.createHash('sha256').update(predBytes).digest('hex')!==from.release_sha256)fail('Shared Contacts predecessor release fingerprint mismatch');
const pred=JSON.parse(predBytes.toString('utf8'));
if(pred.implementation_version!==from.implementation_version||pred.sqlite_schema!==from.sqlite_schema||pred.plugin?.version!==from.plugin_version)fail('Shared Contacts predecessor identity mismatch');
// Task and Shared Contacts have independent release lineages. Cross-component compatibility
// is owned by the immutable Shared Contacts pin in the current Task release below.
if(!/^0\.1\.\d+$/.test(release.implementation_version||'')||!Number.isSafeInteger(release.sqlite_schema)||release.sqlite_schema<1)fail('invalid Shared Contacts generation');
for(const file of ['core.cjs','task-store.cjs','contactctl']){
  if(!shaRe.test(release.runtime_files?.[file]||'')||release.runtime_files[file]!==sha(path.join(root,file)))fail(`runtime file fingerprint mismatch: ${file}`);
}
const pinned=taskRelease?.shared_contacts;
if(pinned?.release_path!=='../../shared/contacts/release.json'||pinned.release_sha256!==sha(releasePath)||pinned.implementation_version!==release.implementation_version||pinned.sqlite_schema!==release.sqlite_schema)fail('Task release Shared Contacts pin mismatch');
const pluginDir=path.join(root,'plugin');
const pkg=JSON.parse(fs.readFileSync(path.join(pluginDir,'package.json'),'utf8'));
const lock=JSON.parse(fs.readFileSync(path.join(pluginDir,'package-lock.json'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.join(pluginDir,'openclaw.plugin.json'),'utf8'));
const plugin=release.plugin;
if(plugin?.name!=='openclaw-plugin-contacts'||plugin.version!==release.implementation_version||pkg.name!==plugin.name||pkg.version!==plugin.version||lock.version!==plugin.version||lock.packages?.['']?.version!==plugin.version||manifest.id!=='contacts'||manifest.version!==plugin.version)fail('Contacts plugin identity mismatch');
if(pkg.dependencies?.typebox!==release.typebox_version||pkg.devDependencies?.openclaw!==release.openclaw_build_version||pkg.peerDependencies?.openclaw!==release.openclaw_compat||pkg.openclaw?.build?.openclawVersion!==release.openclaw_build_version||pkg.openclaw?.compat?.pluginApi!==release.openclaw_compat)fail('Contacts plugin compatibility mismatch');
const artifact=path.join(root,plugin.artifact);
const sidecar=artifact.replace(/\.tgz$/,'.sha256');
if(!fs.existsSync(artifact)||!fs.existsSync(sidecar)||!shaRe.test(plugin.sha256||'')||sha(artifact)!==plugin.sha256)fail('Contacts artifact fingerprint mismatch');
const side=fs.readFileSync(sidecar,'utf8').trim().split(/\s+/);
if(side[0]!==plugin.sha256||side[1]!==path.basename(artifact))fail('Contacts artifact sidecar mismatch');
const artifacts=fs.readdirSync(path.join(root,'artifacts')).filter(x=>/^openclaw-plugin-contacts-.*\.(?:tgz|sha256)$/.test(x));
if(artifacts.some(x=>!['openclaw-plugin-contacts-'+plugin.version+'.tgz','openclaw-plugin-contacts-'+plugin.version+'.sha256'].includes(x)))fail('superseded Contacts artifact retained');
const packed=JSON.parse(execFileSync('tar',['-xOf',artifact,'package/package.json'],{encoding:'utf8'}));
if(packed.name!==plugin.name||packed.version!==plugin.version)fail('Contacts artifact package identity mismatch');
process.stdout.write(JSON.stringify({ok:true,implementation_version:release.implementation_version,sqlite_schema:release.sqlite_schema,plugin_version:plugin.version})+'\n');
