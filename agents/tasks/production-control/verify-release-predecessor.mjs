#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
export const PREDECESSOR_WORKSPACE_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md'];

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

export function validatePredecessorBinding({ release, predecessorRelease, sourceRevision, workspaceSha256, toolsSha256 }) {
  const from = release?.from;
  if (!from || !Array.isArray(from.plugin_versions) || from.plugin_versions.length !== 1) fail('release must declare exactly one supported predecessor');
  if (!SHA_RE.test(sourceRevision ?? '') || from.source_revision !== sourceRevision) fail('predecessor source revision mismatch');
  if (predecessorRelease?.format !== 'task-agent-release-v2') fail('predecessor release format is invalid');

  const predecessorSchema = predecessorRelease?.generation?.sqlite_schema;
  const predecessorTaskctl = predecessorRelease?.generation?.taskctl_version;
  const predecessorPlugin = predecessorRelease?.plugin?.version;
  if (!Number.isSafeInteger(predecessorSchema) || typeof predecessorTaskctl !== 'string' || typeof predecessorPlugin !== 'string') fail('predecessor release identity is incomplete');
  if (!exactSingleton(from.sqlite_schemas, predecessorSchema)) fail('predecessor SQLite identity is not bound to source revision');
  if (!exactSingleton(from.taskctl_versions, predecessorTaskctl)) fail('predecessor taskctl identity is not bound to source revision');
  if (!exactSingleton(from.plugin_versions, predecessorPlugin)) fail('predecessor plugin identity is not bound to source revision');

  if (predecessorPlugin === release?.plugin?.version) {
    const keys = ['name', 'version', 'artifact', 'sha256'];
    const exactReuse = keys.every((key) => predecessorRelease?.plugin?.[key] === release?.plugin?.[key]);
    if (!exactReuse || !SHA256_RE.test(release?.plugin?.sha256 ?? '')) fail('same-version target plugin must reuse exact predecessor plugin artifact identity');
  }

  const declaredWorkspace = from.workspace_sha256;
  if (!declaredWorkspace || Object.keys(declaredWorkspace).sort().join(',') !== PREDECESSOR_WORKSPACE_FILES.slice().sort().join(',')) fail('predecessor workspace fingerprint set is incomplete');
  for (const file of PREDECESSOR_WORKSPACE_FILES) {
    const actual = workspaceSha256?.[file];
    if (!SHA256_RE.test(actual ?? '') || declaredWorkspace[file] !== actual) fail(`predecessor workspace fingerprint mismatch: ${file}`);
  }
  if (!SHA256_RE.test(toolsSha256 ?? '') || from.tools_sha256 !== toolsSha256) fail('predecessor tool-policy fingerprint mismatch');
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

export function verifyReleasePredecessor({ repoRoot = process.cwd(), baseRevision = 'HEAD' } = {}) {
  const releasePath = path.join(repoRoot, 'agents/tasks/release.json');
  const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  const from = release?.from;
  if (!from || !Array.isArray(from.plugin_versions) || from.plugin_versions.length !== 1) fail('release must declare exactly one supported predecessor');

  const sourceRevision = from.source_revision;
  if (!SHA_RE.test(sourceRevision ?? '')) fail('predecessor source revision must be an exact lowercase commit SHA');
  const effectiveBase = SHA_RE.test(baseRevision ?? '') && !/^0{40}$/u.test(baseRevision) ? baseRevision : 'HEAD';
  if (!gitObjectExists(repoRoot, `${effectiveBase}^{commit}`)) fail('predecessor verification base revision is unavailable');
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', effectiveBase, 'HEAD']);
  } catch {
    fail('predecessor verification base revision is not an ancestor of HEAD');
  }

  if (!gitObjectExists(repoRoot, `${sourceRevision}^{commit}`)) fail('predecessor history is unavailable');
  const firstParent = new Set(git(repoRoot, ['rev-list', '--first-parent', effectiveBase]).split(/\n/u).filter(Boolean));
  if (!firstParent.has(sourceRevision)) fail('predecessor source revision is not on the pre-candidate first-parent history');

  const predecessorRelease = JSON.parse(gitShow(repoRoot, sourceRevision, 'agents/tasks/release.json'));
  const workspaceSha256 = Object.fromEntries(PREDECESSOR_WORKSPACE_FILES.map((file) => [
    file,
    sha256(gitShow(repoRoot, sourceRevision, `agents/tasks/workspace/${file}`)),
  ]));
  const predecessorTools = JSON.parse(gitShow(repoRoot, sourceRevision, 'agents/tasks/config/tasks-tools.json'));
  const toolsSha256 = sha256(stableJson(predecessorTools));
  validatePredecessorBinding({ release, predecessorRelease, sourceRevision, workspaceSha256, toolsSha256 });
  return { provenance_mode: 'history', source_revision: sourceRevision, predecessor_plugin: predecessorRelease.plugin.version };
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
