#!/usr/bin/env node
'use strict';

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sortedUniqueIds(items, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(items) || (!allowEmpty && items.length === 0)) {
    throw new Error(`${label} is empty or unavailable`);
  }
  const ids = items.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error(`${label}[${index}] has no valid id`);
    }
    return item.id;
  }).sort();
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate ids`);
  }
  return ids;
}

function agentItems(value) {
  const items = Array.isArray(value) ? value : requireObject(value, 'agent list').agents;
  if (!Array.isArray(items)) throw new Error('agent list is unavailable');
  return items;
}

export function normalizeAgentRoster(value) {
  return sortedUniqueIds(agentItems(value), 'agent list');
}

function normalizeAgentRuntime(value) {
  return agentItems(value).map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error(`agent list[${index}] has no valid id`);
    }
    const runtime = { id: item.id };
    if (item.workspace !== undefined) runtime.workspace = canonicalize(item.workspace);
    if (item.agentDir !== undefined) runtime.agent_dir = canonicalize(item.agentDir);
    if (item.model !== undefined) runtime.model = canonicalize(item.model);
    if (item.bindings !== undefined) runtime.bindings = canonicalize(item.bindings);
    if (item.isDefault !== undefined) runtime.is_default = canonicalize(item.isDefault);
    return runtime;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeToolNames(plugin) {
  const source = Array.isArray(plugin?.toolNames)
    ? plugin.toolNames
    : (Array.isArray(plugin?.contracts?.tools) ? plugin.contracts.tools : []);
  if (source.some((name) => typeof name !== 'string' || name.trim() === '')) {
    throw new Error(`plugin ${plugin?.id ?? '<unknown>'} has invalid tool names`);
  }
  const names = [...source].sort();
  if (new Set(names).size !== names.length) {
    throw new Error(`plugin ${plugin?.id ?? '<unknown>'} has duplicate tool names`);
  }
  return names;
}

function pluginContract(plugin) {
  return {
    id: plugin.id,
    version: typeof plugin.version === 'string' && plugin.version.trim() !== '' ? plugin.version : null,
    tool_names: normalizeToolNames(plugin),
  };
}

function normalizePluginInventory(value) {
  const items = Array.isArray(value) ? value : requireObject(value, 'plugin list').plugins;
  if (!Array.isArray(items)) throw new Error('plugin list is unavailable');
  const active = items.filter((plugin) => plugin?.enabled === true);
  for (const plugin of active) {
    if (plugin?.status !== 'loaded') {
      throw new Error(`active plugin ${plugin?.id ?? '<unknown>'} is not loaded`);
    }
  }
  const external = active.filter((plugin) => plugin?.origin !== 'bundled');
  const activeContracts = active.map(pluginContract).sort((a, b) => a.id.localeCompare(b.id));
  const requiredContracts = external
    .filter((plugin) => plugin?.trustedOfficialInstall !== true)
    .map(pluginContract)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    active_plugin_ids: sortedUniqueIds(active, 'active plugin list', { allowEmpty: true }),
    external_plugin_ids: sortedUniqueIds(external, 'active external plugin list', { allowEmpty: true }),
    active_plugin_contracts: activeContracts,
    required_plugin_contracts: requiredContracts,
  };
}

export function normalizeExternalPluginRoster(value) {
  return normalizePluginInventory(value).external_plugin_ids;
}

function runJson(openclawBin, args) {
  const result = spawnSync(openclawBin, args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`openclaw ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`openclaw ${args.join(' ')} did not return JSON`);
  }
}

export function collectSnapshot(openclawBin, runner = runJson) {
  const config = requireObject(runner(openclawBin, ['config', 'validate', '--json']), 'config validation');
  if (config.valid !== true) throw new Error('effective OpenClaw configuration is invalid');

  const doctor = requireObject(runner(openclawBin, ['plugins', 'doctor', '--json']), 'plugin doctor');
  if (doctor.ok !== true) throw new Error('OpenClaw plugin doctor is not healthy');

  const agents = runner(openclawBin, ['agents', 'list', '--json']);
  const plugins = normalizePluginInventory(runner(openclawBin, ['plugins', 'list', '--json']));
  return {
    agent_ids: normalizeAgentRoster(agents),
    agent_runtime: normalizeAgentRuntime(agents),
    ...plugins,
  };
}

function normalizeIds(items, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(items) || (!allowEmpty && items.length === 0) || items.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new Error(`${label} is invalid`);
  }
  const sorted = [...items].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} contains duplicate ids`);
  return sorted;
}

function normalizeContracts(items, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(items) || (!allowEmpty && items.length === 0)) throw new Error(`${label} is invalid`);
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error(`${label}[${index}] has no valid id`);
    }
    const version = item.version === null || (typeof item.version === 'string' && item.version.trim() !== '')
      ? item.version
      : null;
    const toolNames = Array.isArray(item.tool_names) ? [...item.tool_names].sort() : [];
    if (toolNames.some((name) => typeof name !== 'string' || name.trim() === '') || new Set(toolNames).size !== toolNames.length) {
      throw new Error(`${label}[${index}] has invalid tool names`);
    }
    return { id: item.id, version, tool_names: toolNames };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error(`${label} contains duplicate ids`);
  return normalized;
}

function normalizeAgentRuntimeSnapshot(items, agentIds) {
  if (!Array.isArray(items)) throw new Error('snapshot agent runtime is invalid');
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error(`snapshot agent runtime[${index}] has no valid id`);
    }
    return canonicalize(item);
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (JSON.stringify(normalized.map((item) => item.id)) !== JSON.stringify(agentIds)) {
    throw new Error('snapshot agent runtime does not match agent roster');
  }
  return normalized;
}

export function normalizeSnapshot(value) {
  const snapshot = requireObject(value, 'specialized acceptance snapshot');
  const agentIds = normalizeIds(snapshot.agent_ids, 'snapshot agent ids');
  const normalized = {
    agent_ids: agentIds,
    agent_runtime: normalizeAgentRuntimeSnapshot(snapshot.agent_runtime, agentIds),
    active_plugin_ids: normalizeIds(snapshot.active_plugin_ids, 'snapshot active plugin ids', { allowEmpty: true }),
    external_plugin_ids: normalizeIds(snapshot.external_plugin_ids, 'snapshot external plugin ids', { allowEmpty: true }),
    active_plugin_contracts: normalizeContracts(snapshot.active_plugin_contracts, 'snapshot active plugin contracts'),
    required_plugin_contracts: normalizeContracts(snapshot.required_plugin_contracts, 'snapshot required plugin contracts'),
  };
  const active = new Set(normalized.active_plugin_ids);
  if (normalized.external_plugin_ids.some((id) => !active.has(id))) {
    throw new Error('snapshot external plugin ids are not active');
  }
  if (JSON.stringify(normalized.active_plugin_contracts.map((item) => item.id)) !== JSON.stringify(normalized.active_plugin_ids)) {
    throw new Error('snapshot active plugin contracts do not match active plugin ids');
  }
  const external = new Set(normalized.external_plugin_ids);
  if (normalized.required_plugin_contracts.some((item) => !external.has(item.id))) {
    throw new Error('snapshot required plugin contracts are not external');
  }
  return normalized;
}

export function assertSnapshotPreserved(expectedValue, actualValue) {
  const expected = normalizeSnapshot(expectedValue);
  const actual = normalizeSnapshot(actualValue);
  if (JSON.stringify(actual.agent_ids) !== JSON.stringify(expected.agent_ids)) {
    throw new Error(`agent roster changed: expected ${expected.agent_ids.join(',')} got ${actual.agent_ids.join(',')}`);
  }
  if (JSON.stringify(actual.agent_runtime) !== JSON.stringify(expected.agent_runtime)) {
    throw new Error('agent runtime contract changed');
  }
  const active = new Set(actual.active_plugin_ids);
  const missing = expected.external_plugin_ids.filter((id) => !active.has(id));
  if (missing.length > 0) {
    throw new Error(`previously active external plugins are no longer active: ${missing.join(',')}`);
  }
  const actualContracts = new Map(actual.active_plugin_contracts.map((item) => [item.id, item]));
  for (const expectedContract of expected.required_plugin_contracts) {
    const actualContract = actualContracts.get(expectedContract.id);
    if (!actualContract) {
      throw new Error(`required specialized plugin contract disappeared: ${expectedContract.id}`);
    }
    if (JSON.stringify(actualContract) !== JSON.stringify(expectedContract)) {
      throw new Error(`required specialized plugin contract changed: ${expectedContract.id}`);
    }
  }
  return actual;
}

function usage() {
  console.error('Usage: specialized-agent-acceptance.mjs <snapshot|accept> <openclaw-bin> [expected-json]');
  process.exit(2);
}

function main() {
  const [mode, openclawBin, expectedJson] = process.argv.slice(2);
  if (!openclawBin || (mode !== 'snapshot' && mode !== 'accept')) usage();
  try {
    const actual = collectSnapshot(openclawBin);
    if (mode === 'snapshot') {
      process.stdout.write(`${JSON.stringify(actual)}\n`);
      return;
    }
    if (!expectedJson) usage();
    const expected = JSON.parse(expectedJson);
    const preserved = assertSnapshotPreserved(expected, actual);
    process.stdout.write(`${JSON.stringify({ ok: true, ...preserved })}\n`);
  } catch (error) {
    console.error(`Specialized agent acceptance failed: ${error.message}`);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
