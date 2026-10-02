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

const baseAgents = [
  {
    id: 'main',
    workspace: '/runtime/main',
    agentDir: '/runtime/agents/main',
    model: 'openai/gpt-main',
    bindings: 1,
    isDefault: true,
  },
  {
    id: 'tasks',
    workspace: '/runtime/tasks',
    agentDir: '/runtime/agents/tasks',
    model: 'openai/gpt-tasks',
    bindings: 1,
    isDefault: false,
  },
];

const baseAgentEntries = {
  main: {
    tools: {
      alsoAllow: ['contacts'],
    },
  },
  tasks: {
    tools: {
      profile: 'full',
      allow: ['task_list', 'task_get'],
      deny: ['write', 'exec'],
      fs: { workspaceOnly: true },
    },
  },
};

const basePlugins = {
  plugins: [
    {
      id: 'taskctl',
      enabled: true,
      origin: 'global',
      status: 'loaded',
      version: '0.4.31',
      toolNames: ['task_list', 'task_get'],
    },
    {
      id: 'codex',
      enabled: true,
      origin: 'global',
      status: 'loaded',
      version: '2026.9.7',
      toolNames: ['codex_threads'],
      trustedOfficialInstall: true,
    },
    {
      id: 'telegram',
      enabled: true,
      origin: 'bundled',
      status: 'loaded',
      version: '2026.9.7',
      toolNames: [],
    },
  ],
};

function runnerFor({ agents = baseAgents, agentEntries = baseAgentEntries, plugins = basePlugins } = {}) {
  return (_bin, args) => {
    const command = args.join(' ');
    if (command === 'config validate --json') return { valid: true };
    if (command === 'plugins doctor --json') return { ok: true };
    if (command === 'agents list --json') return agents;
    if (command === 'config get agents.entries --json') return agentEntries;
    if (command === 'plugins list --json') return plugins;
    throw new Error(`unexpected command ${command}`);
  };
}

function baselineSnapshot() {
  return collectSnapshot('/bin/openclaw', runnerFor());
}

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

test('tracks active non-bundled plugins and requires every active plugin loaded', () => {
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

test('collectSnapshot captures agent runtime, tool authority, and custom plugin contracts', () => {
  const calls = [];
  const baseRunner = runnerFor();
  const runner = (bin, args) => {
    calls.push(args.join(' '));
    return baseRunner(bin, args);
  };
  assert.deepEqual(collectSnapshot('/bin/openclaw', runner), {
    agent_ids: ['main', 'tasks'],
    agent_runtime: [
      {
        id: 'main',
        workspace: '/runtime/main',
        agent_dir: '/runtime/agents/main',
        model: 'openai/gpt-main',
        bindings: 1,
        is_default: true,
      },
      {
        id: 'tasks',
        workspace: '/runtime/tasks',
        agent_dir: '/runtime/agents/tasks',
        model: 'openai/gpt-tasks',
        bindings: 1,
        is_default: false,
      },
    ],
    agent_tool_policies: [
      { id: 'main', tools: { alsoAllow: ['contacts'] } },
      {
        id: 'tasks',
        tools: {
          allow: ['task_get', 'task_list'],
          deny: ['exec', 'write'],
          fs: { workspaceOnly: true },
          profile: 'full',
        },
      },
    ],
    active_plugin_ids: ['codex', 'taskctl', 'telegram'],
    external_plugin_ids: ['codex', 'taskctl'],
    active_plugin_contracts: [
      { id: 'codex', version: '2026.9.7', tool_names: ['codex_threads'] },
      { id: 'taskctl', version: '0.4.31', tool_names: ['task_get', 'task_list'] },
      { id: 'telegram', version: '2026.9.7', tool_names: [] },
    ],
    required_plugin_contracts: [
      { id: 'taskctl', version: '0.4.31', tool_names: ['task_get', 'task_list'] },
    ],
  });
  assert.deepEqual(calls, [
    'config validate --json',
    'plugins doctor --json',
    'agents list --json',
    'config get agents.entries --json',
    'plugins list --json',
  ]);
});

test('collectSnapshot accepts a healthy runtime without external plugins', () => {
  const snapshot = collectSnapshot('/bin/openclaw', runnerFor({
    agents: [{ id: 'engineer' }],
    agentEntries: { engineer: { tools: { allow: ['read'] } } },
    plugins: { plugins: [{ id: 'telegram', enabled: true, origin: 'bundled', status: 'loaded' }] },
  }));
  assert.deepEqual(snapshot, {
    agent_ids: ['engineer'],
    agent_runtime: [{ id: 'engineer' }],
    agent_tool_policies: [{ id: 'engineer', tools: { allow: ['read'] } }],
    active_plugin_ids: ['telegram'],
    external_plugin_ids: [],
    active_plugin_contracts: [{ id: 'telegram', version: null, tool_names: [] }],
    required_plugin_contracts: [],
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

test('preservation accepts plugin origin migration, additive plugins, official plugin generation changes, and tool-list reordering', () => {
  const expected = baselineSnapshot();
  const actual = collectSnapshot('/bin/openclaw', runnerFor({
    agentEntries: {
      main: { tools: { alsoAllow: ['contacts'] } },
      tasks: {
        tools: {
          deny: ['exec', 'write'],
          allow: ['task_get', 'task_list'],
          fs: { workspaceOnly: true },
          profile: 'full',
        },
      },
    },
    plugins: {
      plugins: [
        {
          id: 'taskctl',
          enabled: true,
          origin: 'bundled',
          status: 'loaded',
          version: '0.4.31',
          toolNames: ['task_get', 'task_list'],
        },
        {
          id: 'codex',
          enabled: true,
          origin: 'global',
          status: 'loaded',
          version: '2026.9.8',
          toolNames: ['codex_threads'],
          trustedOfficialInstall: true,
        },
        {
          id: 'contacts',
          enabled: true,
          origin: 'global',
          status: 'loaded',
          version: '0.1.7',
          toolNames: ['contact_get'],
        },
        {
          id: 'telegram',
          enabled: true,
          origin: 'bundled',
          status: 'loaded',
          version: '2026.9.8',
          toolNames: [],
        },
      ],
    },
  }));
  assert.deepEqual(assertSnapshotPreserved(expected, actual), actual);
});

test('preservation rejects agent roster, runtime contract, and tool authority drift', () => {
  const expected = baselineSnapshot();
  const missingAgent = collectSnapshot('/bin/openclaw', runnerFor({
    agents: [baseAgents[0]],
    agentEntries: { main: baseAgentEntries.main },
  }));
  assert.throws(() => assertSnapshotPreserved(expected, missingAgent), /agent roster changed/);

  const changedRuntime = collectSnapshot('/bin/openclaw', runnerFor({
    agents: [
      baseAgents[0],
      { ...baseAgents[1], bindings: 0 },
    ],
  }));
  assert.throws(() => assertSnapshotPreserved(expected, changedRuntime), /agent runtime contract changed/);

  const changedAuthority = collectSnapshot('/bin/openclaw', runnerFor({
    agentEntries: {
      ...baseAgentEntries,
      tasks: {
        ...baseAgentEntries.tasks,
        tools: {
          ...baseAgentEntries.tasks.tools,
          deny: ['write'],
        },
      },
    },
  }));
  assert.throws(() => assertSnapshotPreserved(expected, changedAuthority), /agent tool authority policy changed/);
});

test('preservation rejects loss or contract drift of a specialized external plugin', () => {
  const expected = baselineSnapshot();
  const missingPlugin = collectSnapshot('/bin/openclaw', runnerFor({
    plugins: {
      plugins: basePlugins.plugins.filter((plugin) => plugin.id !== 'taskctl'),
    },
  }));
  assert.throws(() => assertSnapshotPreserved(expected, missingPlugin), /no longer active/);

  const changedVersion = collectSnapshot('/bin/openclaw', runnerFor({
    plugins: {
      plugins: basePlugins.plugins.map((plugin) => plugin.id === 'taskctl'
        ? { ...plugin, version: '0.4.32' }
        : plugin),
    },
  }));
  assert.throws(() => assertSnapshotPreserved(expected, changedVersion), /required specialized plugin contract changed: taskctl/);

  const changedTools = collectSnapshot('/bin/openclaw', runnerFor({
    plugins: {
      plugins: basePlugins.plugins.map((plugin) => plugin.id === 'taskctl'
        ? { ...plugin, toolNames: ['task_get'] }
        : plugin),
    },
  }));
  assert.throws(() => assertSnapshotPreserved(expected, changedTools), /required specialized plugin contract changed: taskctl/);
});
