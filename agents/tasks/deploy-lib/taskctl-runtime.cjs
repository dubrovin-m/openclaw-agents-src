#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VERSION_RE = /^0[.]4[.][0-9]+$/u;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*[.]cjs$/u;
const STATE_FORMAT = 'taskctl-runtime-recovery-v1';

function fail(message) { throw new Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function runtimeDescriptor(release, { allowMonolith = false } = {}) {
  const version = release?.generation?.taskctl_version;
  if (!VERSION_RE.test(version || '')) fail('invalid taskctl version');
  const runtime = release?.taskctl_runtime;
  if (!runtime) {
    if (!allowMonolith) fail('taskctl runtime metadata missing');
    return { version, format: 'monolith-v1', files: [] };
  }
  if (runtime.format !== 'node-cjs-modules-v1' || !Array.isArray(runtime.files) || runtime.files.length < 2 || runtime.files.length > 16 || new Set(runtime.files).size !== runtime.files.length || runtime.files.some((file) => !FILE_RE.test(file))) fail('invalid taskctl runtime metadata');
  return { version, format: runtime.format, files: runtime.files.slice() };
}
function regularFile(file) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink();
}
function exactDirEntries(dir, expected) {
  if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) return false;
  const actual = fs.readdirSync(dir).sort();
  return JSON.stringify(actual) === JSON.stringify(expected.slice().sort());
}
function sameFile(a, b) { return fs.readFileSync(a).equals(fs.readFileSync(b)); }
function gitShow(repoRoot, revision, relativePath) {
  return execFileSync('git', ['show', `${revision}:${relativePath}`], { cwd: repoRoot, encoding: null, stdio: ['ignore','pipe','pipe'] });
}
function predecessor(repoRoot, revision) {
  if (!/^[0-9a-f]{40}$/u.test(revision || '')) fail('predecessor revision must be exact SHA');
  const release = JSON.parse(gitShow(repoRoot, revision, 'agents/tasks/release.json').toString('utf8'));
  return { release, runtime: runtimeDescriptor(release, { allowMonolith: true }) };
}
function verifySource(tasksRoot, releasePath) {
  const runtime = runtimeDescriptor(readJson(releasePath));
  const dir = path.join(tasksRoot, 'taskctl-lib');
  if (!regularFile(path.join(tasksRoot, 'taskctl'))) fail('taskctl source entrypoint missing');
  if (!exactDirEntries(dir, runtime.files)) fail('taskctl source module set mismatch');
  for (const file of runtime.files) if (!regularFile(path.join(dir, file))) fail(`invalid taskctl source module: ${file}`);
  return runtime;
}
function verifyModuleDir(tasksRoot, releasePath, installedDir) {
  const runtime = verifySource(tasksRoot, releasePath);
  if (!exactDirEntries(installedDir, runtime.files)) fail('installed taskctl module set mismatch');
  if ((fs.statSync(installedDir).mode & 0o777) !== 0o700) fail('installed taskctl module directory mode mismatch');
  for (const file of runtime.files) {
    const target = path.join(installedDir, file);
    if (!regularFile(target) || (fs.statSync(target).mode & 0o777) !== 0o600) fail(`installed taskctl module invalid: ${file}`);
    if (!sameFile(path.join(tasksRoot, 'taskctl-lib', file), target)) fail(`installed taskctl module content mismatch: ${file}`);
  }
  return runtime;
}
function verifyInstalled(tasksRoot, releasePath, installedEntrypoint, libRoot) {
  const runtime = runtimeDescriptor(readJson(releasePath));
  verifyModuleDir(tasksRoot, releasePath, path.join(libRoot, runtime.version));
  if (!regularFile(installedEntrypoint) || (fs.statSync(installedEntrypoint).mode & 0o777) !== 0o700 || !sameFile(path.join(tasksRoot, 'taskctl'), installedEntrypoint)) fail('installed taskctl entrypoint mismatch');
  if (!exactDirEntries(libRoot, [runtime.version])) fail('taskctl runtime root contains unexpected generations');
  return runtime;
}
function verifyPredecessorInstalled(repoRoot, revision, installedEntrypoint, libRoot) {
  const { runtime } = predecessor(repoRoot, revision);
  if (!regularFile(installedEntrypoint) || (fs.statSync(installedEntrypoint).mode & 0o777) !== 0o700 || !fs.readFileSync(installedEntrypoint).equals(gitShow(repoRoot, revision, 'agents/tasks/taskctl'))) fail('predecessor taskctl entrypoint mismatch');
  if (runtime.format === 'monolith-v1') {
    if (fs.existsSync(libRoot)) fail('monolithic predecessor must not have taskctl runtime module root');
    return runtime;
  }
  if (!exactDirEntries(libRoot, [runtime.version])) fail('predecessor taskctl runtime root mismatch');
  const dir = path.join(libRoot, runtime.version);
  if (!exactDirEntries(dir, runtime.files) || (fs.statSync(dir).mode & 0o777) !== 0o700) fail('predecessor taskctl module directory mismatch');
  for (const file of runtime.files) {
    const target = path.join(dir, file);
    if (!regularFile(target) || (fs.statSync(target).mode & 0o777) !== 0o600) fail(`predecessor taskctl module invalid: ${file}`);
    if (!fs.readFileSync(target).equals(gitShow(repoRoot, revision, `agents/tasks/taskctl-lib/${file}`))) fail(`predecessor taskctl module content mismatch: ${file}`);
  }
  return runtime;
}
function stateFor(runtime) {
  return { format: STATE_FORMAT, version: runtime.version, modules_present: runtime.format !== 'monolith-v1', files: runtime.files };
}
function tarOutput(args) { return execFileSync('tar', args, { encoding: null, stdio: ['ignore','pipe','pipe'] }); }
function verifyRecovery(repoRoot, revision, entrypointBackup, statePath, archivePath) {
  const { runtime } = predecessor(repoRoot, revision);
  if (!regularFile(entrypointBackup) || !fs.readFileSync(entrypointBackup).equals(gitShow(repoRoot, revision, 'agents/tasks/taskctl'))) fail('recovery taskctl entrypoint is not exact predecessor');
  const state = readJson(statePath);
  const expectedState = stateFor(runtime);
  if (JSON.stringify(state) !== JSON.stringify(expectedState)) fail('recovery taskctl runtime state mismatch');
  if (!expectedState.modules_present) {
    if (archivePath && archivePath !== '-') fail('monolithic predecessor must not have taskctl runtime archive');
    return runtime;
  }
  if (!archivePath || archivePath === '-' || !regularFile(archivePath)) fail('modular predecessor recovery archive missing');
  const verbose = tarOutput(['-tvzf', archivePath]).toString('utf8');
  if (verbose.split(/\n/u).filter(Boolean).some((line) => /^[lh]/u.test(line))) fail('taskctl runtime recovery archive contains links');
  const expectedFiles = runtime.files.map((file) => `openclaw-taskctl/${runtime.version}/${file}`).sort();
  const actualFiles = tarOutput(['-tzf', archivePath]).toString('utf8').split(/\n/u).filter((entry) => entry && !entry.endsWith('/')).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) fail('taskctl runtime recovery archive file set mismatch');
  for (const file of runtime.files) {
    const actual = tarOutput(['-xOzf', archivePath, `openclaw-taskctl/${runtime.version}/${file}`]);
    const expected = gitShow(repoRoot, revision, `agents/tasks/taskctl-lib/${file}`);
    if (!actual.equals(expected)) fail(`taskctl runtime recovery content mismatch: ${file}`);
  }
  return runtime;
}

if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'files') {
      const runtime = runtimeDescriptor(readJson(args[0]));
      process.stdout.write(runtime.files.join('\n') + '\n');
    } else if (command === 'source-check') {
      verifySource(args[0], args[1]); process.stdout.write('TASKCTL_SOURCE_RUNTIME_PASS\n');
    } else if (command === 'module-dir-check') {
      verifyModuleDir(args[0], args[1], args[2]); process.stdout.write('TASKCTL_MODULE_DIR_PASS\n');
    } else if (command === 'installed-check') {
      verifyInstalled(args[0], args[1], args[2], args[3]); process.stdout.write('TASKCTL_INSTALLED_RUNTIME_PASS\n');
    } else if (command === 'predecessor-check') {
      verifyPredecessorInstalled(args[0], args[1], args[2], args[3]); process.stdout.write('TASKCTL_PREDECESSOR_RUNTIME_PASS\n');
    } else if (command === 'predecessor-state') {
      process.stdout.write(JSON.stringify(stateFor(predecessor(args[0], args[1]).runtime)) + '\n');
    } else if (command === 'verify-recovery') {
      verifyRecovery(args[0], args[1], args[2], args[3], args[4]); process.stdout.write('TASKCTL_RECOVERY_RUNTIME_PASS\n');
    } else fail('unknown command');
  } catch (error) {
    process.stderr.write(`taskctl-runtime: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { runtimeDescriptor, verifySource, verifyModuleDir, verifyInstalled, verifyPredecessorInstalled, verifyRecovery, stateFor };
