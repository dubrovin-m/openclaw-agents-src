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
function validateArtifact(releasePath, identity, expectedOpenClaw, compat, label) {
  if (identity?.id !== 'training' || identity?.name !== 'openclaw-plugin-training' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(identity?.version ?? '')) fail(`Unexpected ${label} plugin identity`);
  if (!/^[a-f0-9]{64}$/.test(identity?.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(identity?.runtime_entry_sha256 ?? '')) fail(`Invalid ${label} plugin hashes`);
  const artifact = path.resolve(path.dirname(releasePath), requireString(identity.artifact, `${label} plugin artifact`));
  if (!fs.statSync(artifact, {throwIfNoEntry:false})?.isFile()) fail(`${label} plugin artifact missing`);
  if (fileSha(artifact) !== identity.sha256) fail(`${label} plugin artifact checksum mismatch`);
  let packageJson, manifest, runtimeEntry, manifestBytes;
  try {
    packageJson = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], {encoding:'utf8'}));
    manifestBytes = execFileSync('tar', ['-xOf', artifact, 'package/openclaw.plugin.json']);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    runtimeEntry = execFileSync('tar', ['-xOf', artifact, 'package/dist/plugin.js']);
  } catch { fail(`Unable to inspect ${label} plugin artifact`); }
  if (packageJson.name !== identity.name || packageJson.version !== identity.version) fail(`${label} artifact package identity mismatch`);
  if (packageJson?.openclaw?.build?.openclawVersion !== expectedOpenClaw) fail(`${label} artifact OpenClaw build mismatch`);
  if (packageJson?.openclaw?.compat?.pluginApi !== compat) fail(`${label} artifact OpenClaw compat mismatch`);
  if (manifest.id !== identity.id || manifest.version !== identity.version) fail(`${label} artifact manifest identity mismatch`);
  if (sha256(runtimeEntry) !== identity.runtime_entry_sha256) fail(`${label} artifact runtime entry mismatch`);
  return {artifact, manifestSha:sha256(manifestBytes)};
}
function release(root, releasePath, expectedOpenClaw) {
  const r = readJson(releasePath);
  if (r?.format !== 'training-agent-release-v1' || r?.deployment_mode !== 'stage-only') fail('Invalid Training release format/mode');
  const g = r.generation ?? {};
  if (g.sqlite_schema !== 2 || g.typebox_version !== '1.3.15') fail('Unexpected Training generation');
  if (g.openclaw_build_version !== expectedOpenClaw) fail('Training/OpenClaw release version mismatch');
  if (g.openclaw_compat !== `>=2026.9.5 <=${expectedOpenClaw}`) fail('Unexpected Training OpenClaw compatibility');
  const p = r.plugin ?? {};
  const src = r.source ?? {};
  if (!/^[a-f0-9]{40}$/.test(src.source_revision ?? '')) fail('Invalid Training source revision');
  const stage = r.stage_contract ?? {};
  if (JSON.stringify(stage) !== JSON.stringify({plugin_enabled:false,agent_registered:false,telegram_binding:false,database_created:false,training_authority_switch:false})) fail('Unexpected Training stage contract');

  const targetArtifact = validateArtifact(releasePath, p, expectedOpenClaw, g.openclaw_compat, 'Training target');
  const artifact = targetArtifact.artifact;

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

  if (targetArtifact.manifestSha !== src.plugin_manifest_sha256) fail('Training target artifact manifest/source mismatch');
  try { execFileSync('git', ['-C', root, 'cat-file', '-e', `${src.source_revision}^{commit}`], {stdio:'ignore'}); }
  catch { fail('Training source revision is unavailable in repository history'); }

  const predecessor = r.predecessor ?? null;
  let predecessorArtifact = null;
  let predecessorBuildVersion = null;
  if (predecessor) {
    if (!/^[a-f0-9]{40}$/.test(predecessor.source_revision ?? '')) fail('Invalid Training predecessor source revision');
    const expectedWorkspaceKeys = expectedWorkspace.slice().sort();
    const predecessorWorkspace = predecessor.workspace_sha256 ?? {};
    if (JSON.stringify(Object.keys(predecessorWorkspace).sort()) !== JSON.stringify(expectedWorkspaceKeys)) fail('Unexpected Training predecessor workspace release set');
    for (const name of expectedWorkspace) if (!/^[a-f0-9]{64}$/.test(predecessorWorkspace[name] ?? '')) fail(`Invalid predecessor workspace hash: ${name}`);
    if (!/^[a-f0-9]{64}$/.test(predecessor.plugin_manifest_sha256 ?? '')) fail('Invalid Training predecessor manifest hash');
    // A staged predecessor may have been built under the previous qualified host.
    // Bind its package, host compatibility and workspace evidence to its exact historical release.
    let historic;
    try {
      historic = JSON.parse(execFileSync('git', ['-C', root, 'show', `${predecessor.source_revision}:agents/training/release.json`], {encoding:'utf8'}));
      execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', predecessor.source_revision, 'HEAD'], {stdio:'ignore'});
    } catch { fail('Training predecessor source revision is unavailable in accepted repository history'); }
    if (historic?.format !== 'training-agent-release-v1' || historic?.deployment_mode !== 'stage-only') fail('Training predecessor historical release is invalid');
    const historicPlugin = historic.plugin ?? {};
    for (const key of ['id','name','version','artifact','sha256','runtime_entry_sha256']) {
      if (predecessor.plugin?.[key] !== historicPlugin[key]) fail(`Training predecessor historical plugin identity mismatch: ${key}`);
    }
    if (JSON.stringify(predecessorWorkspace) !== JSON.stringify(historic.source?.workspace_sha256 ?? {}) ||
        predecessor.plugin_manifest_sha256 !== historic.source?.plugin_manifest_sha256) {
      fail('Training predecessor historical workspace/manifest identity mismatch');
    }
    const priorBuild = historic.generation?.openclaw_build_version;
    const priorCompat = historic.generation?.openclaw_compat;
    if (!/^\d+\.\d+\.\d+$/.test(priorBuild ?? '') || priorCompat !== `>=2026.9.5 <=${priorBuild}`) {
      fail('Training predecessor historical OpenClaw compatibility is invalid');
    }
    predecessorBuildVersion = priorBuild;
    const checked = validateArtifact(releasePath, predecessor.plugin ?? {}, priorBuild, priorCompat, 'Training predecessor');
    if (checked.manifestSha !== predecessor.plugin_manifest_sha256) fail('Training predecessor artifact manifest mismatch');
    predecessorArtifact = checked.artifact;
  }
  return {r, artifact, predecessorArtifact, predecessorBuildVersion};
}

const command = process.argv[2];
if (command === 'release-env') {
  const root = path.resolve(process.argv[3]);
  const releasePath = path.resolve(process.argv[4]);
  const expected = requireString(process.argv[5], 'expected OpenClaw version');
  const {r, artifact, predecessorArtifact, predecessorBuildVersion} = release(root, releasePath, expected);
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
    PREDECESSOR_PRESENT:r.predecessor ? '1' : '0',
    PREDECESSOR_PLUGIN_VERSION:r.predecessor?.plugin?.version ?? '',
    PREDECESSOR_RUNTIME_ENTRY_SHA:r.predecessor?.plugin?.runtime_entry_sha256 ?? '',
    PREDECESSOR_SOURCE_REVISION:r.predecessor?.source_revision ?? '',
    PREDECESSOR_OPENCLAW_VERSION:predecessorBuildVersion ?? '',
    PREDECESSOR_ARTIFACT:predecessorArtifact ?? '',
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
  const prefix = process.argv[7] ?? 'TRAINING';
  if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) fail('Invalid plugin-env prefix');
  let x;
  try { x = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { fail('Invalid OpenClaw plugin-list JSON'); }
  const matches = (Array.isArray(x?.plugins) ? x.plugins : []).filter(p => p?.id === id);
  const p = matches[0];
  const runtimePath = path.join(rootDir, 'dist/plugin.js');
  const exact = matches.length === 1 && p?.version === version && p?.enabled === false && p?.status === 'disabled' && path.resolve(p?.rootDir ?? '') === rootDir && fs.statSync(runtimePath,{throwIfNoEntry:false})?.isFile() && fileSha(runtimePath) === runtimeSha;
  process.stdout.write(`${prefix}_PLUGIN_COUNT=${shell(matches.length)}\n`);
  process.stdout.write(`${prefix}_PLUGIN_EXACT=${shell(exact ? 1 : 0)}\n`);
  process.stdout.write(`${prefix}_PLUGIN_ENABLED=${shell(p?.enabled === true ? 1 : 0)}\n`);
  process.exit(0);
}

if (command === 'workspace-exact') {
  const dir = path.resolve(process.argv[3]);
  const releasePath = path.resolve(process.argv[4]);
  const r = readJson(releasePath);
  const selector = process.argv[5] ?? 'target';
  if (!['target','predecessor'].includes(selector)) fail('Invalid workspace selector');
  if (!fs.statSync(dir,{throwIfNoEntry:false})?.isDirectory()) process.exit(1);
  const expected = selector === 'predecessor' ? (r?.predecessor?.workspace_sha256 ?? {}) : (r?.source?.workspace_sha256 ?? {});
  const actual = fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir,name)).isFile()).sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(expected).sort())) process.exit(1);
  for (const [name,hash] of Object.entries(expected)) if (fileSha(path.join(dir,name)) !== hash) process.exit(1);
  process.exit(0);
}

fail(`Unknown deploy-support command: ${command ?? ''}`);
