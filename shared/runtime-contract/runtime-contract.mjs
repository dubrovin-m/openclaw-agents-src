#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_RE = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function fail(message) {
  throw new Error(message);
}

export function parseVersion(value) {
  const match = String(value ?? '').trim().match(VERSION_RE);
  if (!match) fail(`invalid semantic version: ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

export function isOpenClawVersionCompatible(version, qualifiedVersion) {
  try {
    return compareVersions(parseVersion(version), parseVersion(qualifiedVersion)) === 0;
  } catch {
    return false;
  }
}

export function validateContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) fail('runtime contract must be an object');
  if (contract.format !== 'openclaw-agents-runtime-contract-v1') fail('unsupported runtime contract format');
  parseVersion(contract?.openclaw?.version);
  const lines = contract?.node?.supported_lines;
  if (!Array.isArray(lines) || lines.length === 0) fail('node supported_lines must be non-empty');
  const majors = new Set();
  for (const line of lines) {
    if (!Number.isSafeInteger(line?.major) || line.major < 1) fail('invalid supported Node major');
    const minimum = parseVersion(line?.minimum);
    if (minimum.major !== line.major) fail(`Node minimum major mismatch for ${line.major}`);
    if (majors.has(line.major)) fail(`duplicate supported Node major ${line.major}`);
    majors.add(line.major);
  }
  if (!isSupportedNodeVersion(contract?.node?.ci_version, contract)) fail('ci_version is outside the supported Node contract');
  const builtins = contract?.node?.required_builtin_modules;
  if (!Array.isArray(builtins) || builtins.some((name) => typeof name !== 'string' || !name.startsWith('node:'))) fail('required_builtin_modules must contain node: module names');
  return contract;
}

export function loadRuntimeContract(file) {
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateContract(contract);
}

export function isSupportedNodeVersion(version, contract) {
  const actual = parseVersion(version);
  const line = contract?.node?.supported_lines?.find((candidate) => candidate.major === actual.major);
  if (!line) return false;
  return compareVersions(actual, parseVersion(line.minimum)) >= 0;
}

export function assertSupportedNodeVersion(version, contract) {
  if (!isSupportedNodeVersion(version, contract)) fail(`unsupported Node runtime: ${version}`);
}

export function assertRepositoryCompatibility(repoRoot, contract = loadRuntimeContract(path.join(repoRoot, 'runtime-contract.json'))) {
  const qualifiedVersion = contract.openclaw.version;
  const release = JSON.parse(fs.readFileSync(path.join(repoRoot, 'agents/tasks/release.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'agents/tasks/plugins/taskctl/package.json'), 'utf8'));
  if (release?.format !== 'task-agent-release-v2') fail('unsupported Task Agent release format');
  const buildVersion = release?.generation?.openclaw_build_version;
  const compatRange = release?.generation?.openclaw_compat;
  parseVersion(buildVersion);
  if (buildVersion !== qualifiedVersion || !isOpenClawVersionCompatible(qualifiedVersion, compatRange)) fail('Task plugin compatibility must equal the qualified OpenClaw runtime');
  if (pkg?.peerDependencies?.openclaw !== compatRange) fail('Task plugin OpenClaw peer range differs from release compatibility');
  if (pkg?.openclaw?.compat?.pluginApi !== compatRange) fail('Task plugin API range differs from release compatibility');
  if (pkg?.devDependencies?.openclaw !== buildVersion) fail('Task plugin OpenClaw dev dependency differs from release build version');
  if (pkg?.openclaw?.build?.openclawVersion !== buildVersion) fail('Task plugin build metadata differs from release build version');
  if (release?.generation?.typebox_version !== pkg?.dependencies?.typebox) fail('Task release TypeBox version differs from plugin dependency');

  const contactsRelease = JSON.parse(fs.readFileSync(path.join(repoRoot, 'shared/contacts/release.json'), 'utf8'));
  const contactsPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'shared/contacts/plugin/package.json'), 'utf8'));
  if (contactsRelease?.format !== 'shared-contacts-release-v1') fail('unsupported Shared Contacts release format');
  if (contactsRelease?.openclaw_build_version !== qualifiedVersion || !isOpenClawVersionCompatible(qualifiedVersion, contactsRelease?.openclaw_compat)) fail('Contacts plugin compatibility must equal the qualified OpenClaw runtime');
  if (contactsPkg?.peerDependencies?.openclaw !== contactsRelease.openclaw_compat) fail('Contacts plugin OpenClaw peer range differs from release compatibility');
  if (contactsPkg?.openclaw?.compat?.pluginApi !== contactsRelease.openclaw_compat) fail('Contacts plugin API range differs from release compatibility');
  if (contactsPkg?.devDependencies?.openclaw !== contactsRelease.openclaw_build_version) fail('Contacts plugin OpenClaw dev dependency differs from release build version');
  if (contactsPkg?.openclaw?.build?.openclawVersion !== contactsRelease.openclaw_build_version) fail('Contacts plugin build metadata differs from release build version');

  return {
    ok: true,
    openclaw_version: qualifiedVersion,
    node_ci_version: contract.node.ci_version,
    taskctl_version: release.generation.taskctl_version,
    plugin_version: release.plugin.version,
    openclaw_build_version: buildVersion,
    openclaw_compat: compatRange,
    contacts_plugin_version: contactsRelease.plugin.version,
    contacts_openclaw_build_version: contactsRelease.openclaw_build_version,
    contacts_openclaw_compat: contactsRelease.openclaw_compat,
  };
}

async function assertRequiredBuiltinModules(contract) {
  for (const name of contract.node.required_builtin_modules) {
    try {
      await import(name);
    } catch {
      fail(`required Node builtin unavailable: ${name}`);
    }
  }
}

async function cli() {
  const [command = 'validate', arg1, arg2] = process.argv.slice(2);
  if (command === 'validate') {
    const file = path.resolve(arg1 || 'runtime-contract.json');
    const contract = loadRuntimeContract(file);
    assertSupportedNodeVersion(process.version, contract);
    await assertRequiredBuiltinModules(contract);
    process.stdout.write(`${JSON.stringify({ ok: true, openclaw_version: contract.openclaw.version, node_version: process.version, node_ci_version: contract.node.ci_version })}\n`);
    return;
  }
  if (command === 'repo-check') {
    const repoRoot = path.resolve(arg1 || '.');
    const result = assertRepositoryCompatibility(repoRoot);
    assertSupportedNodeVersion(process.version, loadRuntimeContract(path.join(repoRoot, 'runtime-contract.json')));
    await assertRequiredBuiltinModules(loadRuntimeContract(path.join(repoRoot, 'runtime-contract.json')));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'node-ci') {
    const contract = loadRuntimeContract(path.resolve(arg1 || 'runtime-contract.json'));
    process.stdout.write(`${contract.node.ci_version}\n`);
    return;
  }
  if (command === 'openclaw-version') {
    const contract = loadRuntimeContract(path.resolve(arg1 || 'runtime-contract.json'));
    process.stdout.write(`${contract.openclaw.version}\n`);
    return;
  }
  if (command === 'check-node') {
    const contract = loadRuntimeContract(path.resolve(arg1 || 'runtime-contract.json'));
    assertSupportedNodeVersion(arg2 || process.version, contract);
    await assertRequiredBuiltinModules(contract);
    process.stdout.write('RUNTIME_NODE_COMPATIBILITY_PASS\n');
    return;
  }
  fail('Usage: runtime-contract.mjs <validate|repo-check|node-ci|openclaw-version|check-node> [path] [version]');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  cli().catch((error) => {
    process.stderr.write(`runtime-contract: ${error.message}\n`);
    process.exitCode = 2;
  });
}
