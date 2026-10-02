import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSnapshotPreserved,
  collectSnapshot,
  normalizeAgentRoster,
  normalizeExternalPluginRoster,
} from '../specialized-agent-acceptance.mjs';
import {
  isProtectedDeploymentPath,
  isRolloutProtectedPath,
  isStagedValidationOnlyPath,
} from '../lib.mjs';

const acceptancePath = 'agents/tasks/production-control/specialized-agent-acceptance.mjs';

test('classifies the runtime acceptance helper inside controller protection boundaries', () => {
  assert.equal(isProtectedDeploymentPath(acceptancePath), true);
  assert.equal(isRolloutProtectedPath(acceptancePath), true);
  assert.equal(isStagedValidationOnlyPath(acceptancePath), true);
});

test('normalizes agent roster from current array output', () => {
  assert.deepEqual(normalizeAgentRoster([{ id: 'tasks' }, { id: 'main' }, { id: 'engineer' }]), [
    'engineer',
    'main',
    'tasks',
  ]);
});

test('normalizes agent roster from object output', () => {
  assert.deepEqual(normalizeAgentRoster({ agents: [{ id: 'calendar' }, { id: 'investments' }] }), [
    'calendar',
    'investments',
  ]);
});

test('tracks only active non-bundled plugins and requires every active plugin loaded', () => {
  const plugins = {
    plugins: [
      { id: 'taskctl', enabled: true, origin: 'global', status: 'loaded' },
      { id: 'calendar-analytics', enabled: true, origin: 'global', status: 'loaded' },
      { id: 'telegram', enabled: true, origin: 'bundled', status: 'loaded' },
      { id: 'unused-global', enabled: false, origin: 'global', status: 'disabled' },
    ],
  };
  assert.deepEqual(normalizeExternalPluginRoster(plugins), ['calendar-analytics', 'taskctl']);
  assert.deepEqual(
    normalizeExternalPluginRoster({ plugins: [{ id: 'telegram', enabled: true, origin: 'bundled', status: 'loaded' }] }),
    [],
  );
  assert.throws(
    () => normalizeExternalPluginRoster({ plugins: [{ id: 'telegram', enabled: true, origin: 'bundled', status: 'error' }] }),
    /is not loaded/,
  );
});

test('collectSnapshot requires config and plugin health before inventory', () => {
  const calls = [];
  const runner = (_bin, args) => {
    calls.push(args.join(' '));
    const command = args.join(' ');
    if (command === 'config validate --json') return { valid: true };
    if (command === 'plugins doctor --json') return { ok: true };
    if (command === 'agents list --json') return [{ id: 'tasks' }, { id: 'main' }];
    if (command === 'plugins list --json') {
      return {
        plugins: [
          { id: 'taskctl', enabled: true, origin: 'global', status: 'loaded' },
          { id: 'telegram', enabled: true, origin: 'bundled', status: 'loaded' },
        ],
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  assert.deepEqual(collectSnapshot('/bin/openclaw', runner), {
    agent_ids: ['main', 'tasks'],
    active_plugin_ids: ['taskctl', 'telegram'],
    external_plugin_ids: ['taskctl'],
  });
  assert.deepEqual(calls, [
    'config validate --json',
    'plugins doctor --json',
    'agents list --json',
    'plugins list --json',
  ]);
});

test('collectSnapshot accepts a healthy runtime without external plugins', () => {
  const runner = (_bin, args) => {
    const command = args.join(' ');
    if (command === 'config validate --json') return { valid: true };
    if (command === 'plugins doctor --json') return { ok: true };
    if (command === 'agents list --json') return [{ id: 'engineer' }];
    if (command === 'plugins list --json') return { plugins: [{ id: 'telegram', enabled: true, origin: 'bundled', status: 'loaded' }] };
    throw new Error(`unexpected command ${command}`);
  };
  assert.deepEqual(collectSnapshot('/bin/openclaw', runner), {
    agent_ids: ['engineer'],
    active_plugin_ids: ['telegram'],
    external_plugin_ids: [],
  });
});

test('collectSnapshot fails closed on unhealthy deterministic probes', () => {
  assert.throws(
    () => collectSnapshot('/bin/openclaw', (_bin, args) => {
      if (args[0] === 'config') return { valid: false };
      throw new Error('must not continue');
    }),
    /configuration is invalid/,
  );
  assert.throws(
    () => collectSnapshot('/bin/openclaw', (_bin, args) => {
      if (args[0] === 'config') return { valid: true };
      if (args[0] === 'plugins' && args[1] === 'doctor') return { ok: false };
      throw new Error('must not continue');
    }),
    /plugin doctor is not healthy/,
  );
});

test('preservation accepts plugin origin migration and new plugins', () => {
  const expected = {
    agent_ids: ['main', 'tasks'],
    active_plugin_ids: ['taskctl', 'telegram'],
    external_plugin_ids: ['taskctl'],
  };
  const actual = {
    agent_ids: ['main', 'tasks'],
    active_plugin_ids: ['contacts', 'taskctl', 'telegram'],
    external_plugin_ids: ['contacts'],
  };
  assert.deepEqual(assertSnapshotPreserved(expected, actual), actual);
});

test('preservation rejects agent drift or loss of a previously active external plugin', () => {
  const expected = {
    agent_ids: ['main', 'tasks'],
    active_plugin_ids: ['taskctl', 'telegram'],
    external_plugin_ids: ['taskctl'],
  };
  assert.throws(
    () => assertSnapshotPreserved(expected, {
      agent_ids: ['main'],
      active_plugin_ids: ['taskctl', 'telegram'],
      external_plugin_ids: ['taskctl'],
    }),
    /agent roster changed/,
  );
  assert.throws(
    () => assertSnapshotPreserved(expected, {
      agent_ids: ['main', 'tasks'],
      active_plugin_ids: ['telegram'],
      external_plugin_ids: [],
    }),
    /no longer active/,
  );
});
