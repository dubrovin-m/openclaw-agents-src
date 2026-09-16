#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
export const PREDECESSOR_WORKSPACE_FILES = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md'];
const PUBLIC_BOOTSTRAP_PATH = 'agents/tasks/public-source-bootstrap.json';

const fail = (message) => { throw new Error(message); };

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactSingleton(values, expected) {
  return Array.isArray(values) && values.length === 1 && values[0] === expected;
}

export function validatePredecessorBinding({ release, predecessorRelease, sourceRevision, workspaceSourceRevision = sourceRevision, workspaceSha256, toolsSha256 }) {
  const from = release?.from;
  if (!from || !Array.isArray(from.plugin_versions)) fail('release predecessor metadata is invalid');

  if (from.plugin_versions.length === 0) {
    if (from.source_revision !== null) fail('retired predecessor source revision remains');
    if (from.workspace_source_revision !== undefined && from.workspace_source_revision !== null) fail('retired predecessor workspace source revision remains');
    return true;
  }

  if (!SHA_RE.test(sourceRevision ?? '') || from.source_revision !== sourceRevision) fail('predecessor source revision mismatch');
  const declaredWorkspaceSourceRevision = from.workspace_source_revision ?? sourceRevision;
  if (!SHA_RE.test(workspaceSourceRevision ?? '') || declaredWorkspaceSourceRevision !== workspaceSourceRevision) fail('predecessor workspace source revision mismatch');
  if (predecessorRelease?.format !== 'task-agent-release-v2') fail('predecessor release format is invalid');

  const predecessorSchema = predecessorRelease?.generation?.sqlite_schema;
  const predecessorTaskctl = predecessorRelease?.generation?.taskctl_version;
  const predecessorPlugin = predecessorRelease?.plugin?.version;
  if (!Number.isSafeInteger(predecessorSchema) || typeof predecessorTaskctl !== 'string' || typeof predecessorPlugin !== 'string') fail('predecessor release identity is incomplete');
  if (!exactSingleton(from.sqlite_schemas, predecessorSchema)) fail('predecessor SQLite identity is not bound to source revision');
  if (!exactSingleton(from.taskctl_versions, predecessorTaskctl)) fail('predecessor taskctl identity is not bound to source revision');
  if (!exactSingleton(from.plugin_versions, predecessorPlugin)) fail('predecessor plugin identity is not bound to source revision');
  if (predecessorPlugin === release?.plugin?.version) fail('target plugin cannot be its own predecessor');

  const declaredWorkspace = from.workspace_sha256;
  if (!declaredWorkspace || Object.keys(declaredWorkspace).sort().join(',') !== PREDECESSOR_WORKSPACE_FILES.slice().sort().join(',')) fail('predecessor workspace fingerprint set is incomplete');
  for (const file of PREDECESSOR_WORKSPACE_FILES) {
    const actual = workspaceSha256?.[file];
    if (!SHA256_RE.test(actual ?? '') || declaredWorkspace[file] !== actual) fail(`predecessor workspace fingerprint mismatch: ${file}`);
  }
  if (!SHA256_RE.test(toolsSha256 ?? '') || from.tools_sha256 !== toolsSha256) fail('predecessor tool-policy fingerprint mismatch');
  return true;
}

export function validatePublicBootstrapBridge({ release, marker }) {
  const from = release?.from;
  if (marker?.format !== 'task-agent-public-source-bootstrap-v1') fail('public bootstrap bridge format is invalid');
  if (!from || !Array.isArray(from.plugin_versions) || from.plugin_versions.length !== 1) fail('public bootstrap bridge requires one declared predecessor');
  const target = marker?.target;
  const legacy = marker?.legacy_predecessor;
  const snapshot = marker?.public_snapshot;
  const historicalTests = marker?.historical_test_revisions;
  if (target?.plugin_version !== release?.plugin?.version) fail('public bootstrap bridge target plugin mismatch');
  if (target?.taskctl_version !== release?.generation?.taskctl_version) fail('public bootstrap bridge target taskctl mismatch');
  if (target?.sqlite_schema !== release?.generation?.sqlite_schema) fail('public bootstrap bridge target SQLite schema mismatch');
  if (!SHA256_RE.test(target?.release_sha256 ?? '') || target.release_sha256 !== sha256(stableJson(release))) fail('public bootstrap bridge release fingerprint mismatch');
  const sourceRevision = from.source_revision;
  const workspaceSourceRevision = from.workspace_source_revision ?? sourceRevision;
  if (legacy?.source_revision !== sourceRevision || legacy?.workspace_source_revision !== workspaceSourceRevision) fail('public bootstrap bridge predecessor revision mismatch');
  if (!SHA_RE.test(snapshot?.commit ?? '') || !SHA_RE.test(snapshot?.tree ?? '') || !SHA_RE.test(snapshot?.parent ?? '')) fail('public bootstrap bridge snapshot identity is invalid');
  if (!SHA_RE.test(historicalTests?.batch7_schema4_source_revision ?? '') || !SHA_RE.test(historicalTests?.schema5_source_revision ?? '')) fail('public bootstrap bridge historical test revision is invalid');
  return true;
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function gitShow(repoRoot, revision, relativePath) {
  return execFileSync('git', ['show', `${revision}:${relativePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitObjectExists(repoRoot, revisionSpec) {
  try {
    execFileSync('git', ['cat-file', '-e', revisionSpec], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function verifyPublicBootstrapBridge({ repoRoot, release, sourceRevision, workspaceSourceRevision }) {
  const markerPath = path.join(repoRoot, PUBLIC_BOOTSTRAP_PATH);
  if (!fs.existsSync(markerPath)) fail('predecessor history is unavailable and public bootstrap bridge is missing');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  validatePublicBootstrapBridge({ release, marker });
  const snapshot = marker.public_snapshot;
  if (!gitObjectExists(repoRoot, `${snapshot.commit}^{commit}`)) fail('public bootstrap snapshot commit is unavailable');
  if (!gitObjectExists(repoRoot, `${snapshot.parent}^{commit}`)) fail('public bootstrap parent commit is unavailable');
  const snapshotTree = git(repoRoot, ['rev-parse', `${snapshot.commit}^{tree}`]);
  if (snapshotTree !== snapshot.tree) fail('public bootstrap snapshot tree mismatch');
  const snapshotParents = git(repoRoot, ['show', '-s', '--format=%P', snapshot.commit]).split(/\s+/u).filter(Boolean);
  if (snapshotParents.length !== 1 || snapshotParents[0] !== snapshot.parent) fail('public bootstrap snapshot ancestry mismatch');
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', snapshot.commit, 'HEAD']);
  } catch {
    fail('public bootstrap snapshot is not an ancestor of HEAD');
  }
  const snapshotRelease = JSON.parse(gitShow(repoRoot, snapshot.commit, 'agents/tasks/release.json'));
  if (sha256(stableJson(snapshotRelease)) !== marker.target.release_sha256) fail('public bootstrap snapshot release fingerprint mismatch');
  return {
    provenance_mode: 'public-bootstrap-bridge',
    source_revision: sourceRevision,
    workspace_source_revision: workspaceSourceRevision,
    predecessor_plugin: release.from.plugin_versions[0],
    public_snapshot: snapshot.commit,
  };
}

export function verifyReleasePredecessor({ repoRoot = process.cwd(), baseRevision = 'HEAD' } = {}) {
  const releasePath = path.join(repoRoot, 'agents/tasks/release.json');
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  const from = release?.from;
  if (!from || !Array.isArray(from.plugin_versions)) fail('release predecessor metadata is invalid');
  if (from.plugin_versions.length === 0) {
    validatePredecessorBinding({ release, predecessorRelease: null, sourceRevision: null, workspaceSourceRevision: null, workspaceSha256: {}, toolsSha256: null });
    return { provenance_mode: 'none', source_revision: null, workspace_source_revision: null, predecessor_plugin: null };
  }

  const sourceRevision = from.source_revision;
  if (!SHA_RE.test(sourceRevision ?? '')) fail('predecessor source revision must be an exact lowercase commit SHA');
  const workspaceSourceRevision = from.workspace_source_revision ?? sourceRevision;
  if (!SHA_RE.test(workspaceSourceRevision ?? '')) fail('predecessor workspace source revision must be an exact lowercase commit SHA');
  const effectiveBase = SHA_RE.test(baseRevision ?? '') && !/^0{40}$/u.test(baseRevision) ? baseRevision : 'HEAD';
  if (!gitObjectExists(repoRoot, `${effectiveBase}^{commit}`)) fail('predecessor verification base revision is unavailable');
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', effectiveBase, 'HEAD']);
  } catch {
    fail('predecessor verification base revision is not an ancestor of HEAD');
  }
  const sourcePresent = gitObjectExists(repoRoot, `${sourceRevision}^{commit}`);
  const workspaceSourcePresent = gitObjectExists(repoRoot, `${workspaceSourceRevision}^{commit}`);
  if (!sourcePresent || !workspaceSourcePresent) {
    if (sourcePresent !== workspaceSourcePresent) fail('predecessor history is only partially available');
    return verifyPublicBootstrapBridge({ repoRoot, release, sourceRevision, workspaceSourceRevision });
  }
  git(repoRoot, ['cat-file', '-e', `${effectiveBase}^{commit}`]);
  const firstParent = new Set(git(repoRoot, ['rev-list', '--first-parent', effectiveBase]).split(/\n/u).filter(Boolean));
  if (!firstParent.has(sourceRevision)) fail('predecessor source revision is not on the pre-candidate first-parent history');
  if (!firstParent.has(workspaceSourceRevision)) fail('predecessor workspace source revision is not on the pre-candidate first-parent history');
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', sourceRevision, workspaceSourceRevision]);
  } catch {
    fail('predecessor workspace source revision does not descend from predecessor source revision');
  }

  const predecessorRelease = JSON.parse(gitShow(repoRoot, sourceRevision, 'agents/tasks/release.json'));
  const workspaceSha256 = Object.fromEntries(PREDECESSOR_WORKSPACE_FILES.map((file) => [
    file,
    sha256(gitShow(repoRoot, workspaceSourceRevision, `agents/tasks/workspace/${file}`)),
  ]));
  const predecessorTools = JSON.parse(gitShow(repoRoot, sourceRevision, 'agents/tasks/config/tasks-tools.json'));
  const toolsSha256 = sha256(stableJson(predecessorTools));
  validatePredecessorBinding({ release, predecessorRelease, sourceRevision, workspaceSourceRevision, workspaceSha256, toolsSha256 });
  return { provenance_mode: 'history', source_revision: sourceRevision, workspace_source_revision: workspaceSourceRevision, predecessor_plugin: predecessorRelease.plugin.version };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const baseRevision = process.argv[2] || 'HEAD';
    const result = verifyReleasePredecessor({ baseRevision });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`release-predecessor: ${error.message}\n`);
    process.exitCode = 2;
  }
}
