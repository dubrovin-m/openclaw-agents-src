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

function normalizeRoutingBindings(value, agentIds, label = 'routing bindings') {
  if (!Array.isArray(value)) throw new Error(`${label} is unavailable`);
  const knownAgents = new Set(agentIds);
  const normalized = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label}[${index}] is invalid`);
    }
    const agentId = typeof item.agentId === 'string' ? item.agentId : item.agent_id;
    if (typeof agentId !== 'string' || agentId.trim() === '' || !knownAgents.has(agentId)) {
      throw new Error(`${label}[${index}] references unknown agent`);
    }
    const match = requireObject(item.match, `${label}[${index}].match`);
    return { agent_id: agentId, match: canonicalize(match) };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const keys = normalized.map((item) => JSON.stringify(item));
  if (new Set(keys).size !== keys.length) throw new Error(`${label} contains duplicates`);
  return normalized;
}

function normalizeStringSet(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${label} is invalid`);
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} contains duplicates`);
  return sorted;
}

function normalizeAgentToolPolicyValue(value, path = 'tools') {
  if (Array.isArray(value)) return value.map((item, index) => normalizeAgentToolPolicyValue(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (['allow', 'deny', 'alsoAllow'].includes(key) && Array.isArray(child)) {
        out[key] = normalizeStringSet(child, `${path}.${key}`);
      } else {
        out[key] = normalizeAgentToolPolicyValue(child, `${path}.${key}`);
      }
    }
    return out;
  }
  return value;
}

function normalizeAgentToolPolicies(value, agentIds) {
  const entries = requireObject(value, 'agent entries');
  const entryIds = Object.keys(entries).sort();
  if (JSON.stringify(entryIds) !== JSON.stringify(agentIds)) {
    throw new Error('agent entries do not match agent roster');
  }
  return entryIds.map((id) => {
    const entry = requireObject(entries[id], `agent entries.${id}`);
    return {
      id,
      tools: entry.tools === undefined ? null : normalizeAgentToolPolicyValue(entry.tools),
    };
  });
}

function normalizeAgentEntries(value, agentIds) {
  const entries = requireObject(value, 'agent entries');
  const entryIds = Object.keys(entries).sort();
  if (JSON.stringify(entryIds) !== JSON.stringify(agentIds)) {
    throw new Error('agent entries do not match agent roster');
  }
  return entryIds.map((id) => {
    const entry = requireObject(entries[id], `agent entries.${id}`);
    const normalized = canonicalize(entry);
    if (entry.tools !== undefined) normalized.tools = normalizeAgentToolPolicyValue(entry.tools);
    return { id, entry: normalized };
  });
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

const DISABLED_TRAINING_WARNING = '- plugins.entries.training: plugin disabled (disabled in config) but config is present';

function onlyDisabledTrainingWarning(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== false) return false;
  const expectedKeys = ['compatibility', 'configurationWarnings', 'diagnostics', 'ok', 'pluginErrors', 'sourceShadowing'];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) return false;
  if (!['pluginErrors', 'diagnostics', 'sourceShadowing', 'compatibility']
    .every((field) => Array.isArray(value[field]) && value[field].length === 0)) return false;
  return Array.isArray(value.configurationWarnings)
    && value.configurationWarnings.length === 1
    && value.configurationWarnings[0] === DISABLED_TRAINING_WARNING;
}

function grantsTrainingTool(policy, knownToolNames) {
  if (!policy || typeof policy !== 'object') return false;
  return Object.entries(policy).some(([key, value]) => {
    if (['allow', 'alsoAllow'].includes(key) && Array.isArray(value)
      && value.some((name) => typeof name === 'string'
        && (knownToolNames.has(name) || /^training(?:[._:]|$)/u.test(name)))) return true;
    return value && typeof value === 'object' && grantsTrainingTool(value, knownToolNames);
  });
}

function runJson(openclawBin, args) {
  const result = spawnSync(openclawBin, args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  if (result.status !== 0) {
    const optionalUnsetPath = args.join(' ') === 'config get tools --json'
      && parsed?.ok === false
      && parsed?.error?.type === 'cli_error'
      && parsed?.error?.message === 'Config path is valid but unset: tools. The runtime default applies until you set an authored value with openclaw config set tools <value>.';
    if (optionalUnsetPath) return null;
    if (args.join(' ') === 'plugins doctor --json' && result.status === 1 && onlyDisabledTrainingWarning(parsed)) {
      return parsed;
    }
    const detail = String(result.stderr ?? '').trim() || String(parsed?.error?.message ?? '').trim();
    throw new Error(`openclaw ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  if (parsed === undefined) throw new Error(`openclaw ${args.join(' ')} did not return JSON`);
  return parsed;
}

export function collectSnapshot(openclawBin, runner = runJson) {
  const config = requireObject(runner(openclawBin, ['config', 'validate', '--json']), 'config validation');
  if (config.valid !== true) throw new Error('effective OpenClaw configuration is invalid');

  const doctor = requireObject(runner(openclawBin, ['plugins', 'doctor', '--json']), 'plugin doctor');
  const disabledTrainingWarning = onlyDisabledTrainingWarning(doctor);
  if (doctor.ok !== true && !disabledTrainingWarning) throw new Error('OpenClaw plugin doctor is not healthy');
  if (disabledTrainingWarning
    && runner(openclawBin, ['config', 'get', 'plugins.entries.training.enabled', '--json']) !== false) {
    throw new Error('Training disabled warning contradicts effective plugin configuration');
  }

  const agents = runner(openclawBin, ['agents', 'list', '--json']);
  const agentIds = normalizeAgentRoster(agents);
  const routingBindings = runner(openclawBin, ['agents', 'bindings', '--json']);
  const agentEntries = runner(openclawBin, ['config', 'get', 'agents.entries', '--json']);
  const globalTools = runner(openclawBin, ['config', 'get', 'tools', '--json']);
  const pluginList = runner(openclawBin, ['plugins', 'list', '--json']);
  if (disabledTrainingWarning) {
    if (agentIds.includes('training') || Object.hasOwn(requireObject(agentEntries, 'agent entries'), 'training')) {
      throw new Error('Training disabled warning contradicts agent authority');
    }
    const items = Array.isArray(pluginList) ? pluginList : requireObject(pluginList, 'plugin list').plugins;
    if (!Array.isArray(items)) throw new Error('plugin list is unavailable');
    const training = items.filter((plugin) => plugin?.id === 'training');
    if (training.length !== 1 || training[0].enabled !== false || training[0].status !== 'disabled') {
      throw new Error('Training disabled warning contradicts effective plugin state');
    }
    const trainingToolNames = new Set(normalizeToolNames(training[0]));
    if (grantsTrainingTool(globalTools, trainingToolNames)
      || Object.values(agentEntries).some((entry) => grantsTrainingTool(entry?.tools, trainingToolNames))) {
      throw new Error('Training disabled warning contradicts explicit tool authority');
    }
  }
  const plugins = normalizePluginInventory(pluginList);
  return {
    agent_ids: agentIds,
    agent_runtime: normalizeAgentRuntime(agents),
    routing_bindings: normalizeRoutingBindings(routingBindings, agentIds),
    global_tool_policy: normalizeAgentToolPolicyValue(globalTools, 'tools'),
    agent_entries: normalizeAgentEntries(agentEntries, agentIds),
    agent_tool_policies: normalizeAgentToolPolicies(agentEntries, agentIds),
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

function normalizeAgentEntriesSnapshot(items, agentIds) {
  if (!Array.isArray(items)) throw new Error('snapshot agent entries are invalid');
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error(`snapshot agent entries[${index}] has no valid id`);
    }
    const entry = requireObject(item.entry, `snapshot agent entries[${index}].entry`);
    const normalizedEntry = canonicalize(entry);
    if (entry.tools !== undefined) normalizedEntry.tools = normalizeAgentToolPolicyValue(entry.tools);
    return { id: item.id, entry: normalizedEntry };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (JSON.stringify(normalized.map((item) => item.id)) !== JSON.stringify(agentIds)) {
    throw new Error('snapshot agent entries do not match agent roster');
  }
  return normalized;
}

function normalizeAgentToolPolicySnapshot(items, agentIds) {
  if (!Array.isArray(items)) throw new Error('snapshot agent tool policies are invalid');
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error(`snapshot agent tool policies[${index}] has no valid id`);
    }
    return {
      id: item.id,
      tools: item.tools === null || item.tools === undefined ? null : normalizeAgentToolPolicyValue(item.tools),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (JSON.stringify(normalized.map((item) => item.id)) !== JSON.stringify(agentIds)) {
    throw new Error('snapshot agent tool policies do not match agent roster');
  }
  return normalized;
}

export function normalizeSnapshot(value) {
  const snapshot = requireObject(value, 'specialized acceptance snapshot');
  const agentIds = normalizeIds(snapshot.agent_ids, 'snapshot agent ids');
  const normalized = {
    agent_ids: agentIds,
    agent_runtime: normalizeAgentRuntimeSnapshot(snapshot.agent_runtime, agentIds),
    routing_bindings: normalizeRoutingBindings(snapshot.routing_bindings, agentIds, 'snapshot routing bindings'),
    global_tool_policy: normalizeAgentToolPolicyValue(snapshot.global_tool_policy, 'snapshot global tools'),
    agent_entries: normalizeAgentEntriesSnapshot(snapshot.agent_entries, agentIds),
    agent_tool_policies: normalizeAgentToolPolicySnapshot(snapshot.agent_tool_policies, agentIds),
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

function assertEqual(label, expected, actual) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} changed`);
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
  if (JSON.stringify(actual.routing_bindings) !== JSON.stringify(expected.routing_bindings)) {
    throw new Error('agent routing bindings changed');
  }
  if (JSON.stringify(actual.global_tool_policy) !== JSON.stringify(expected.global_tool_policy)) {
    throw new Error('global tool authority policy changed');
  }
  if (JSON.stringify(actual.agent_entries) !== JSON.stringify(expected.agent_entries)) {
    throw new Error('agent entry configuration changed');
  }
  if (JSON.stringify(actual.agent_tool_policies) !== JSON.stringify(expected.agent_tool_policies)) {
    throw new Error('agent tool authority policy changed');
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

function normalizeStagingAllowance(value, expected) {
  const allowance = requireObject(value, 'staging allowance');
  const keys = Object.keys(allowance).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['mutable_plugin_ids', 'target_agent_tool_policies'])) {
    throw new Error('staging allowance has unexpected fields');
  }
  const mutablePluginIds = normalizeIds(allowance.mutable_plugin_ids, 'mutable staged plugin ids');
  const targetPolicies = requireObject(allowance.target_agent_tool_policies, 'target staged agent tool policies');
  const expectedAgents = new Set(expected.agent_ids);
  const normalizedTargetPolicies = new Map();
  for (const id of Object.keys(targetPolicies).sort()) {
    if (typeof id !== 'string' || id.trim() === '' || !expectedAgents.has(id)) {
      throw new Error(`target staged agent tool policy references unknown agent: ${id}`);
    }
    const tools = targetPolicies[id];
    normalizedTargetPolicies.set(id, tools === null ? null : normalizeAgentToolPolicyValue(tools, `staging allowance.${id}.tools`));
  }
  return { mutablePluginIds, targetPolicies: normalizedTargetPolicies };
}

export function assertStagedSnapshotAllowed(expectedValue, actualValue, stagingAllowanceValue) {
  const expected = normalizeSnapshot(expectedValue);
  const actual = normalizeSnapshot(actualValue);
  const { mutablePluginIds, targetPolicies } = normalizeStagingAllowance(stagingAllowanceValue, expected);
  const mutable = new Set(mutablePluginIds);
  const expectedExternal = new Set(expected.external_plugin_ids);
  const expectedRequired = new Set(expected.required_plugin_contracts.map((item) => item.id));

  for (const id of mutablePluginIds) {
    if (!expectedExternal.has(id) || !expectedRequired.has(id)) {
      throw new Error(`mutable staged plugin is not an existing operator-managed external plugin: ${id}`);
    }
  }

  assertEqual('agent roster during staging', expected.agent_ids, actual.agent_ids);
  assertEqual('agent runtime contract during staging', expected.agent_runtime, actual.agent_runtime);
  assertEqual('agent routing bindings during staging', expected.routing_bindings, actual.routing_bindings);
  assertEqual('global tool authority policy during staging', expected.global_tool_policy, actual.global_tool_policy);
  const actualEntries = new Map(actual.agent_entries.map((item) => [item.id, item]));
  for (const expectedEntry of expected.agent_entries) {
    const actualEntry = actualEntries.get(expectedEntry.id);
    if (targetPolicies.has(expectedEntry.id)) {
      const targetEntry = { id: expectedEntry.id, entry: { ...expectedEntry.entry } };
      if (targetPolicies.get(expectedEntry.id) === null) {
        delete targetEntry.entry.tools;
      } else {
        targetEntry.entry.tools = targetPolicies.get(expectedEntry.id);
      }
      if (JSON.stringify(actualEntry) !== JSON.stringify(targetEntry)) {
        throw new Error(`staged agent entry does not match frozen target: ${expectedEntry.id}`);
      }
    } else if (JSON.stringify(actualEntry) !== JSON.stringify(expectedEntry)) {
      throw new Error(`non-staged agent entry configuration changed during staging: ${expectedEntry.id}`);
    }
  }
  const actualPolicies = new Map(actual.agent_tool_policies.map((item) => [item.id, item]));
  for (const expectedPolicy of expected.agent_tool_policies) {
    const actualPolicy = actualPolicies.get(expectedPolicy.id);
    if (targetPolicies.has(expectedPolicy.id)) {
      if (JSON.stringify(actualPolicy?.tools) !== JSON.stringify(targetPolicies.get(expectedPolicy.id))) {
        throw new Error(`staged agent tool policy does not match frozen target: ${expectedPolicy.id}`);
      }
    } else if (JSON.stringify(actualPolicy) !== JSON.stringify(expectedPolicy)) {
      throw new Error(`non-staged agent tool authority policy changed during staging: ${expectedPolicy.id}`);
    }
  }
  assertEqual('active plugin roster during staging', expected.active_plugin_ids, actual.active_plugin_ids);
  assertEqual('external plugin roster during staging', expected.external_plugin_ids, actual.external_plugin_ids);
  assertEqual(
    'operator-managed plugin roster during staging',
    expected.required_plugin_contracts.map((item) => item.id),
    actual.required_plugin_contracts.map((item) => item.id),
  );

  const actualActiveContracts = new Map(actual.active_plugin_contracts.map((item) => [item.id, item]));
  for (const expectedContract of expected.active_plugin_contracts) {
    if (mutable.has(expectedContract.id)) continue;
    const actualContract = actualActiveContracts.get(expectedContract.id);
    if (JSON.stringify(actualContract) !== JSON.stringify(expectedContract)) {
      throw new Error(`non-staged plugin contract changed during staging: ${expectedContract.id}`);
    }
  }

  const actualRequiredContracts = new Map(actual.required_plugin_contracts.map((item) => [item.id, item]));
  for (const expectedContract of expected.required_plugin_contracts) {
    if (mutable.has(expectedContract.id)) continue;
    const actualContract = actualRequiredContracts.get(expectedContract.id);
    if (JSON.stringify(actualContract) !== JSON.stringify(expectedContract)) {
      throw new Error(`operator-managed plugin contract changed during staging: ${expectedContract.id}`);
    }
  }

  return actual;
}

function usage() {
  console.error('Usage: specialized-agent-acceptance.mjs <snapshot|accept|stage> <openclaw-bin> [expected-json] [staging-allowance-json]');
  process.exit(2);
}

function main() {
  const [mode, openclawBin, expectedJson, stagingAllowanceJson, ...extra] = process.argv.slice(2);
  if (!openclawBin || !['snapshot', 'accept', 'stage'].includes(mode) || extra.length !== 0) usage();
  try {
    const actual = collectSnapshot(openclawBin);
    if (mode === 'snapshot') {
      if (expectedJson !== undefined || stagingAllowanceJson !== undefined) usage();
      process.stdout.write(`${JSON.stringify(actual)}\n`);
      return;
    }
    if (!expectedJson) usage();
    const expected = JSON.parse(expectedJson);
    if (mode === 'stage') {
      if (!stagingAllowanceJson) usage();
      const allowance = JSON.parse(stagingAllowanceJson);
      const staged = assertStagedSnapshotAllowed(expected, actual, allowance);
      process.stdout.write(`${JSON.stringify(staged)}\n`);
      return;
    }
    if (stagingAllowanceJson !== undefined) usage();
    const preserved = assertSnapshotPreserved(expected, actual);
    process.stdout.write(`${JSON.stringify({ ok: true, ...preserved })}\n`);
  } catch (error) {
    console.error(`Specialized agent acceptance failed: ${error.message}`);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
