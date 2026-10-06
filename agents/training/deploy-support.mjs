#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function fileSha(file) {
  return sha256(fs.readFileSync(file));
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(`Invalid JSON: ${file}`); }
}
function shell(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}
function requireString(value, label) {
  if (typeof value !== 'string' || !value) fail(`Invalid ${label}`);
  return value;
}
function release(root, releasePath, expectedOpenClaw) {
  const r = readJson(releasePath);
  if (r?.format !== 'training-agent-release-v1' || r?.deployment_mode !== 'stage-only') fail('Invalid Training release format/mode');
  const g = r.generation ?? {};
  if (g.sqlite_schema !== 1 || g.typebox_version !== '1.3.15') fail('Unexpected Training generation');
  if (g.openclaw_build_version !== expectedOpenClaw) fail('Training/OpenClaw release version mismatch');
  if (g.openclaw_compat !== '>=2026.9.5 <=2026.9.7') fail('Unexpected Training OpenClaw compatibility');
  const p = r.plugin ?? {};
  if (p.id !== 'training' || p.name !== 'openclaw-plugin-training' || p.version !== '0.1.0') fail('Unexpected Training plugin identity');
  if (!/^[a-f0-9]{64}$/.test(p.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(p.runtime_entry_sha256 ?? '')) fail('Invalid Training plugin hashes');
  const src = r.source ?? {};
  if (!/^[a-f0-9]{40}$/.test(src.source_revision ?? '')) fail('Invalid Training source revision');
  const stage = r.stage_contract ?? {};
  if (JSON.stringify(stage) !== JSON.stringify({plugin_enabled:false,agent_registered:false,telegram_binding:false,database_created:false,training_authority_switch:false})) fail('Unexpected Training stage contract');

  const artifact = path.resolve(path.dirname(releasePath), requireString(p.artifact, 'plugin artifact'));
  if (!fs.statSync(artifact, {throwIfNoEntry:false})?.isFile()) fail('Training plugin artifact missing');
  if (fileSha(artifact) !== p.sha256) fail('Training plugin artifact checksum mismatch');

  const workspace = src.workspace_sha256 ?? {};
  const expectedWorkspace = ['AGENTS.md','HEARTBEAT.md','IDENTITY.md','SOUL.md','USER.md'];
  if (JSON.stringify(Object.keys(workspace).sort()) !== JSON.stringify(expectedWorkspace.slice().sort())) fail('Unexpected Training workspace release set');
  for (const name of expectedWorkspace) {
    if (!/^[a-f0-9]{64}$/.test(workspace[name] ?? '')) fail(`Invalid workspace hash: ${name}`);
    if (fileSha(path.join(root, 'agents/training/workspace', name)) !== workspace[name]) fail(`Training workspace drift: ${name}`);
  }
  const exactFiles = [
    ['agents/training/config/training-tools.json', src.tools_sha256, 'tool policy'],
    ['agents/training/config/training-agent.fragment.json', src.agent_fragment_sha256, 'agent fragment'],
    ['agents/training/plugin/openclaw.plugin.json', src.plugin_manifest_sha256, 'plugin manifest'],
  ];
  for (const [rel, expected, label] of exactFiles) {
    if (!/^[a-f0-9]{64}$/.test(expected ?? '') || fileSha(path.join(root, rel)) !== expected) fail(`Training ${label} drift`);
  }

  let packageJson, manifest, runtimeEntry;
  try {
    packageJson = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], {encoding:'utf8'}));
    manifest = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/openclaw.plugin.json'], {encoding:'utf8'}));
    runtimeEntry = execFileSync('tar', ['-xOf', artifact, 'package/dist/plugin.js']);
  } catch { fail('Unable to inspect Training plugin artifact'); }
  if (packageJson.name !== p.name || packageJson.version !== p.version) fail('Training artifact package identity mismatch');
  if (packageJson?.openclaw?.build?.openclawVersion !== expectedOpenClaw) fail('Training artifact OpenClaw build mismatch');
  if (packageJson?.openclaw?.compat?.pluginApi !== g.openclaw_compat) fail('Training artifact OpenClaw compat mismatch');
  if (manifest.id !== p.id || manifest.version !== p.version) fail('Training artifact manifest identity mismatch');
  if (sha256(runtimeEntry) !== p.runtime_entry_sha256) fail('Training artifact runtime entry mismatch');
  try { execFileSync('git', ['-C', root, 'cat-file', '-e', `${src.source_revision}^{commit}`], {stdio:'ignore'}); }
  catch { fail('Training source revision is unavailable in repository history'); }
  return {r, artifact};
}

const command = process.argv[2];
if (command === 'release-env') {
  const root = path.resolve(process.argv[3]);
  const releasePath = path.resolve(process.argv[4]);
  const expected = requireString(process.argv[5], 'expected OpenClaw version');
  const {r, artifact} = release(root, releasePath, expected);
  const env = {
    TARGET_PLUGIN_ID:r.plugin.id,
    TARGET_PLUGIN_NAME:r.plugin.name,
    TARGET_PLUGIN_VERSION:r.plugin.version,
    TARGET_PLUGIN_SHA:r.plugin.sha256,
    TARGET_RUNTIME_ENTRY_SHA:r.plugin.runtime_entry_sha256,
    TARGET_SCHEMA:String(r.generation.sqlite_schema),
    TARGET_OPENCLAW_VERSION:r.generation.openclaw_build_version,
    SOURCE_REVISION:r.source.source_revision,
    ARTIFACT:artifact,
  };
  for (const [key,value] of Object.entries(env)) process.stdout.write(`${key}=${shell(value)}\n`);
  process.exit(0);
}

if (command === 'config-env') {
  const config = readJson(path.resolve(process.argv[3]));
  const expectedDb = path.resolve(process.argv[4]);
  const entries = config?.agents?.entries;
  let agents = [];
  if (Array.isArray(entries)) agents = entries.filter(x => x && typeof x === 'object' && (x.id === 'training' || x.name === 'training' || x.workspace?.endsWith('/workspace-training')));
  else if (entries && typeof entries === 'object' && entries.training) agents = [entries.training];
  const bindings = Array.isArray(config?.bindings) ? config.bindings.filter(x => x?.agentId === 'training') : [];
  const plugin = config?.plugins?.entries?.training;
  const allow = Array.isArray(config?.plugins?.allow) ? config.plugins.allow.filter(x => x === 'training') : [];
  const out = {
    TRAINING_AGENT_COUNT:agents.length,
    TRAINING_BINDING_COUNT:bindings.length,
    TRAINING_PLUGIN_CONFIG_PRESENT:plugin ? 1 : 0,
    TRAINING_PLUGIN_ENABLED:plugin?.enabled === true ? 1 : 0,
    TRAINING_PLUGIN_DB_EXACT:plugin?.config?.databasePath === expectedDb ? 1 : 0,
    TRAINING_ALLOW_COUNT:allow.length,
  };
  for (const [key,value] of Object.entries(out)) process.stdout.write(`${key}=${shell(value)}\n`);
  process.exit(0);
}

if (command === 'plugin-env') {
  const id = requireString(process.argv[3], 'plugin id');
  const version = requireString(process.argv[4], 'plugin version');
  const rootDir = path.resolve(process.argv[5]);
  const runtimeSha = requireString(process.argv[6], 'runtime SHA');
  let x;
  try { x = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { fail('Invalid OpenClaw plugin-list JSON'); }
  const matches = (Array.isArray(x?.plugins) ? x.plugins : []).filter(p => p?.id === id);
  const p = matches[0];
  const runtimePath = path.join(rootDir, 'dist/plugin.js');
  const exact = matches.length === 1 && p?.version === version && p?.enabled === false && p?.status === 'disabled' && path.resolve(p?.rootDir ?? '') === rootDir && fs.statSync(runtimePath,{throwIfNoEntry:false})?.isFile() && fileSha(runtimePath) === runtimeSha;
  process.stdout.write(`TRAINING_PLUGIN_COUNT=${shell(matches.length)}\n`);
  process.stdout.write(`TRAINING_PLUGIN_EXACT=${shell(exact ? 1 : 0)}\n`);
  process.stdout.write(`TRAINING_PLUGIN_ENABLED=${shell(p?.enabled === true ? 1 : 0)}\n`);
  process.exit(0);
}

if (command === 'workspace-exact') {
  const dir = path.resolve(process.argv[3]);
  const releasePath = path.resolve(process.argv[4]);
  const r = readJson(releasePath);
  if (!fs.statSync(dir,{throwIfNoEntry:false})?.isDirectory()) process.exit(1);
  const expected = r?.source?.workspace_sha256 ?? {};
  const actual = fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir,name)).isFile()).sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(expected).sort())) process.exit(1);
  for (const [name,hash] of Object.entries(expected)) if (fileSha(path.join(dir,name)) !== hash) process.exit(1);
  process.exit(0);
}

fail(`Unknown deploy-support command: ${command ?? ''}`);
