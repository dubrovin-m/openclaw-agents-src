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

export function normalizeAgentRoster(value) {
  const items = Array.isArray(value) ? value : requireObject(value, 'agent list').agents;
  return sortedUniqueIds(items, 'agent list');
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
  return {
    active_plugin_ids: sortedUniqueIds(active, 'active plugin list', { allowEmpty: true }),
    external_plugin_ids: sortedUniqueIds(external, 'active external plugin list', { allowEmpty: true }),
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

  const agentIds = normalizeAgentRoster(runner(openclawBin, ['agents', 'list', '--json']));
  const plugins = normalizePluginInventory(runner(openclawBin, ['plugins', 'list', '--json']));
  return {
    agent_ids: agentIds,
    ...plugins,
  };
}

export function normalizeSnapshot(value) {
  const snapshot = requireObject(value, 'specialized acceptance snapshot');
  const normalizeIds = (items, label, { allowEmpty = false } = {}) => {
    if (!Array.isArray(items) || (!allowEmpty && items.length === 0) || items.some((id) => typeof id !== 'string' || id.trim() === '')) {
      throw new Error(`${label} is invalid`);
    }
    const sorted = [...items].sort();
    if (new Set(sorted).size !== sorted.length) throw new Error(`${label} contains duplicate ids`);
    return sorted;
  };
  const normalized = {
    agent_ids: normalizeIds(snapshot.agent_ids, 'snapshot agent ids'),
    active_plugin_ids: normalizeIds(snapshot.active_plugin_ids, 'snapshot active plugin ids', { allowEmpty: true }),
    external_plugin_ids: normalizeIds(snapshot.external_plugin_ids, 'snapshot external plugin ids', { allowEmpty: true }),
  };
  const active = new Set(normalized.active_plugin_ids);
  if (normalized.external_plugin_ids.some((id) => !active.has(id))) {
    throw new Error('snapshot external plugin ids are not active');
  }
  return normalized;
}

export function assertSnapshotPreserved(expectedValue, actualValue) {
  const expected = normalizeSnapshot(expectedValue);
  const actual = normalizeSnapshot(actualValue);
  if (JSON.stringify(actual.agent_ids) !== JSON.stringify(expected.agent_ids)) {
    throw new Error(`agent roster changed: expected ${expected.agent_ids.join(',')} got ${actual.agent_ids.join(',')}`);
  }
  const active = new Set(actual.active_plugin_ids);
  const missing = expected.external_plugin_ids.filter((id) => !active.has(id));
  if (missing.length > 0) {
    throw new Error(`previously active external plugins are no longer active: ${missing.join(',')}`);
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
