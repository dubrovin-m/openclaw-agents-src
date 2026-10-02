import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSnapshotPreserved,
  collectSnapshot,
  normalizeAgentRoster,
  normalizeExternalPluginRoster,
} from '../specialized-agent-acceptance.mjs';

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

test('tracks only active non-bundled plugins and requires them loaded', () => {
  const plugins = {
    plugins: [
      { id: 'taskctl', enabled: true, origin: 'global', status: 'loaded' },
      { id: 'calendar-analytics', enabled: true, origin: 'global', status: 'loaded' },
      { id: 'telegram', enabled: true, origin: 'bundled', status: 'loaded' },
      { id: 'unused-global', enabled: false, origin: 'global', status: 'disabled' },
    ],
  };
  assert.deepEqual(normalizeExternalPluginRoster(plugins), ['calendar-analytics', 'taskctl']);
  assert.throws(
    () => normalizeExternalPluginRoster({ plugins: [{ id: 'taskctl', enabled: true, origin: 'global', status: 'error' }] }),
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
    if (command === 'plugins list --json') return { plugins: [{ id: 'taskctl', enabled: true, origin: 'global', status: 'loaded' }] };
    throw new Error(`unexpected command ${command}`);
  };
  assert.deepEqual(collectSnapshot('/bin/openclaw', runner), {
    agent_ids: ['main', 'tasks'],
    external_plugin_ids: ['taskctl'],
  });
  assert.deepEqual(calls, [
    'config validate --json',
    'plugins doctor --json',
    'agents list --json',
    'plugins list --json',
  ]);
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

test('preservation rejects agent or external plugin identity drift', () => {
  const expected = { agent_ids: ['main', 'tasks'], external_plugin_ids: ['taskctl'] };
  assert.deepEqual(assertSnapshotPreserved(expected, expected), expected);
  assert.throws(
    () => assertSnapshotPreserved(expected, { agent_ids: ['main'], external_plugin_ids: ['taskctl'] }),
    /agent roster changed/,
  );
  assert.throws(
    () => assertSnapshotPreserved(expected, { agent_ids: ['main', 'tasks'], external_plugin_ids: ['contacts', 'taskctl'] }),
    /external plugin roster changed/,
  );
});
