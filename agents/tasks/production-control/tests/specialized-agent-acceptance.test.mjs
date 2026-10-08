import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertSnapshotPreserved,
  assertStagedSnapshotAllowed,
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
const disabledTrainingDoctor = {
  ok: false,
  pluginErrors: [],
  diagnostics: [],
  sourceShadowing: [],
  compatibility: [],
  configurationWarnings: [
    '- plugins.entries.training: plugin disabled (disabled in config) but config is present',
  ],
};
const disabledTrainingPlugin = {
  id: 'training',
  enabled: false,
  status: 'disabled',
  origin: 'global',
  toolNames: ['training_log'],
};

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

const baseBindings = [
  { agentId: 'main', match: { channel: 'telegram', accountId: 'main' } },
  { agentId: 'tasks', match: { channel: 'telegram', accountId: 'tasks' } },
];

const baseAgentEntries = {
  main: {
    skills: ['contacts'],
    tools: {
      alsoAllow: ['contacts'],
    },
  },
  tasks: {
    bootstrapMaxChars: 12000,
    bootstrapTotalMaxChars: 24000,
    tools: {
      profile: 'full',
      allow: ['task_list', 'task_get'],
      deny: ['write', 'exec'],
      fs: { workspaceOnly: true },
    },
  },
};

const baseGlobalTools = {
  profile: 'coding',
  deny: ['browser'],
  sessions: { visibility: 'tree' },
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

function runnerFor({
  agents = baseAgents,
  bindings,
  agentEntries = baseAgentEntries,
  globalTools = baseGlobalTools,
  plugins = basePlugins,
  doctor = { ok: true },
  trainingEnabled = false,
} = {}) {
  const runtimeBindings = bindings ?? baseBindings.filter((binding) => agents.some((agent) => agent.id === binding.agentId));
  return (_bin, args) => {
    const command = args.join(' ');
    if (command === 'config validate --json') return { valid: true };
    if (command === 'plugins doctor --json') return doctor;
    if (command === 'config get plugins.entries.training.enabled --json') return trainingEnabled;
    if (command === 'agents list --json') return agents;
    if (command === 'agents bindings --json') return runtimeBindings;
    if (command === 'config get agents.entries --json') return agentEntries;
    if (command === 'config get tools --json') return globalTools;
    if (command === 'plugins list --json') return plugins;
    throw new Error(`unexpected command ${command}`);
  };
}

function baselineSnapshot() {
  return collectSnapshot('/bin/openclaw', runnerFor());
}

function stagingAllowance(targetTasksTools = baseAgentEntries.tasks.tools) {
  return {
    mutable_plugin_ids: ['taskctl'],
    target_agent_tool_policies: { tasks: targetTasksTools },
  };
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
    routing_bindings: [
      { agent_id: 'main', match: { accountId: 'main', channel: 'telegram' } },
      { agent_id: 'tasks', match: { accountId: 'tasks', channel: 'telegram' } },
    ],
    global_tool_policy: {
      deny: ['browser'],
      profile: 'coding',
      sessions: { visibility: 'tree' },
    },
    agent_entries: [
      {
        id: 'main',
        entry: {
          skills: ['contacts'],
          tools: { alsoAllow: ['contacts'] },
        },
      },
      {
        id: 'tasks',
        entry: {
          bootstrapMaxChars: 12000,
          bootstrapTotalMaxChars: 24000,
          tools: {
            allow: ['task_get', 'task_list'],
            deny: ['exec', 'write'],
            fs: { workspaceOnly: true },
            profile: 'full',
          },
        },
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
    'agents bindings --json',
    'config get agents.entries --json',
    'config get tools --json',
    'plugins list --json',
  ]);
});


test('accepts only the exact disabled Training warning and leaves active snapshot unchanged', () => {
  const plugins = { plugins: [...basePlugins.plugins, disabledTrainingPlugin] };
  const actual = collectSnapshot('/bin/openclaw', runnerFor({ doctor: disabledTrainingDoctor, plugins }));
  assert.deepEqual(actual, baselineSnapshot());
});

test('rejects unrelated or malformed doctor warnings and all nonempty diagnostic categories', () => {
  const plugins = { plugins: [...basePlugins.plugins, disabledTrainingPlugin] };
  const badDoctors = [
    { ...disabledTrainingDoctor, configurationWarnings: ['- another warning'] },
    { ...disabledTrainingDoctor, configurationWarnings: [...disabledTrainingDoctor.configurationWarnings, '- extra'] },
    { ...disabledTrainingDoctor, configurationWarnings: [] },
    { ...disabledTrainingDoctor, pluginErrors: ['plugin broke'] },
    { ...disabledTrainingDoctor, diagnostics: ['diagnostic'] },
    { ...disabledTrainingDoctor, sourceShadowing: ['shadowed'] },
    { ...disabledTrainingDoctor, compatibility: ['incompatible'] },
    { ...disabledTrainingDoctor, unrelated: 'unknown field' },
    { ok: false, configurationWarnings: disabledTrainingDoctor.configurationWarnings },
  ];
  for (const doctor of badDoctors) {
    assert.throws(
      () => collectSnapshot('/bin/openclaw', runnerFor({ doctor, plugins })),
      /plugin doctor is not healthy/,
    );
  }
});

test('disabled Training exception refuses enablement, runtime authority, and plugin mismatch', () => {
  const plugins = { plugins: [...basePlugins.plugins, disabledTrainingPlugin] };
  const scenarios = [
    [{ trainingEnabled: true }, /effective plugin configuration/],
    [{ trainingEnabled: null }, /effective plugin configuration/],
    [{ plugins: basePlugins }, /effective plugin state/],
    [{ plugins: { plugins: [...basePlugins.plugins, { ...disabledTrainingPlugin, enabled: true, status: 'loaded' }] } }, /effective plugin state/],
    [{ plugins: { plugins: [...basePlugins.plugins, { ...disabledTrainingPlugin, status: 'error' }] } }, /effective plugin state/],
    [{ plugins: { plugins: [...plugins.plugins, disabledTrainingPlugin] } }, /effective plugin state/],
    [{ agents: [...baseAgents, { id: 'training' }], agentEntries: { ...baseAgentEntries, training: {} } }, /agent authority/],
    [{ bindings: [...baseBindings, { agentId: 'training', match: { channel: 'telegram', accountId: 'training' } }] }, /unknown agent/],
    [{ globalTools: { ...baseGlobalTools, alsoAllow: ['training_log'] } }, /explicit tool authority/],
    [{ agentEntries: { ...baseAgentEntries, main: { ...baseAgentEntries.main, tools: { alsoAllow: ['training_log'] } } } }, /explicit tool authority/],
  ];
  for (const [overrides, message] of scenarios) {
    assert.throws(
      () => collectSnapshot('/bin/openclaw', runnerFor({ doctor: disabledTrainingDoctor, plugins, ...overrides })),
      message,
    );
  }
});

test('nonzero doctor exit code is accepted only for the exact exception', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specialized-doctor-'));
  try {
    const responses = {
      'config validate --json': { valid: true },
      'plugins doctor --json': disabledTrainingDoctor,
      'config get plugins.entries.training.enabled --json': false,
      'agents list --json': baseAgents,
      'agents bindings --json': baseBindings,
      'config get agents.entries --json': baseAgentEntries,
      'config get tools --json': baseGlobalTools,
      'plugins list --json': { plugins: [...basePlugins.plugins, disabledTrainingPlugin] },
    };
    const createShim = (name, doctorExit) => {
      const bin = path.join(dir, name);
      fs.writeFileSync(bin, `#!/usr/bin/env node
const responses = ${JSON.stringify(responses)};
const cmd = process.argv.slice(2).join(' ');
if (!Object.hasOwn(responses, cmd)) process.exit(3);
process.stdout.write(JSON.stringify(responses[cmd])+'\\n');
process.exit(cmd === 'plugins doctor --json' ? ${doctorExit} : 0);
`, { mode: 0o700 });
      return bin;
    };
    assert.deepEqual(collectSnapshot(createShim('doctor-warning-exit-1', 1)), baselineSnapshot());
    assert.throws(
      () => collectSnapshot(createShim('doctor-warning-exit-2', 2)),
      /openclaw plugins doctor --json failed/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectSnapshot accepts a healthy runtime without external plugins', () => {
  const snapshot = collectSnapshot('/bin/openclaw', runnerFor({
    agents: [{ id: 'engineer' }],
    agentEntries: { engineer: { tools: { allow: ['read'] } } },
    globalTools: { profile: 'coding' },
    plugins: { plugins: [{ id: 'telegram', enabled: true, origin: 'bundled', status: 'loaded' }] },
  }));
  assert.deepEqual(snapshot, {
    agent_ids: ['engineer'],
    agent_runtime: [{ id: 'engineer' }],
    routing_bindings: [],
    global_tool_policy: { profile: 'coding' },
    agent_entries: [{ id: 'engineer', entry: { tools: { allow: ['read'] } } }],
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
      main: {
        ...baseAgentEntries.main,
        tools: { alsoAllow: ['contacts'] },
      },
      tasks: {
        ...baseAgentEntries.tasks,
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

  const changedRouting = collectSnapshot('/bin/openclaw', runnerFor({
    bindings: [
      baseBindings[0],
      { agentId: 'tasks', match: { channel: 'telegram', accountId: 'tasks-v2' } },
    ],
  }));
  assert.throws(() => assertSnapshotPreserved(expected, changedRouting), /agent routing bindings changed/);

  const changedGlobalAuthority = collectSnapshot('/bin/openclaw', runnerFor({
    globalTools: {
      ...baseGlobalTools,
      profile: 'full',
    },
  }));
  assert.throws(() => assertSnapshotPreserved(expected, changedGlobalAuthority), /global tool authority policy changed/);

  const changedEntry = collectSnapshot('/bin/openclaw', runnerFor({
    agentEntries: {
      ...baseAgentEntries,
      tasks: {
        ...baseAgentEntries.tasks,
        bootstrapMaxChars: 16000,
      },
    },
  }));
  assert.throws(() => assertSnapshotPreserved(expected, changedEntry), /agent entry configuration changed/);

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
  assert.throws(() => assertSnapshotPreserved(expected, changedAuthority), /agent entry configuration changed/);
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

test('staging allows Task-owned plugin contract and exact frozen Task tool policy changes', () => {
  const expected = baselineSnapshot();
  const targetTasksTools = {
    ...baseAgentEntries.tasks.tools,
    deny: ['write'],
  };
  const actual = collectSnapshot('/bin/openclaw', runnerFor({
    agentEntries: {
      ...baseAgentEntries,
      tasks: { ...baseAgentEntries.tasks, tools: targetTasksTools },
    },
    plugins: {
      plugins: basePlugins.plugins.map((plugin) => plugin.id === 'taskctl'
        ? { ...plugin, version: '0.4.32', toolNames: ['task_get', 'task_list', 'task_update'] }
        : plugin),
    },
  }));
  assert.deepEqual(assertStagedSnapshotAllowed(expected, actual, stagingAllowance(targetTasksTools)), actual);
});

test('staging rejects routing drift', () => {
  const expected = baselineSnapshot();
  const actual = collectSnapshot('/bin/openclaw', runnerFor({
    bindings: [
      baseBindings[0],
      { agentId: 'tasks', match: { channel: 'telegram', accountId: 'tasks-v2' } },
    ],
  }));
  assert.throws(
    () => assertStagedSnapshotAllowed(expected, actual, stagingAllowance()),
    /agent routing bindings during staging changed/,
  );
});

test('staging rejects global tool policy and non-tool agent-entry drift', () => {
  const expected = baselineSnapshot();
  const changedGlobal = collectSnapshot('/bin/openclaw', runnerFor({
    globalTools: { ...baseGlobalTools, deny: [] },
  }));
  assert.throws(
    () => assertStagedSnapshotAllowed(expected, changedGlobal, stagingAllowance()),
    /global tool authority policy during staging changed/,
  );

  const changedEntry = collectSnapshot('/bin/openclaw', runnerFor({
    agentEntries: {
      ...baseAgentEntries,
      tasks: { ...baseAgentEntries.tasks, bootstrapTotalMaxChars: 32000 },
    },
  }));
  assert.throws(
    () => assertStagedSnapshotAllowed(expected, changedEntry, stagingAllowance()),
    /staged agent entry does not match frozen target: tasks/,
  );
});

test('staging rejects Task authority drift that does not match the frozen target', () => {
  const expected = baselineSnapshot();
  const actual = collectSnapshot('/bin/openclaw', runnerFor({
    agentEntries: {
      ...baseAgentEntries,
      tasks: {
        ...baseAgentEntries.tasks,
        tools: {
          ...baseAgentEntries.tasks.tools,
          deny: [],
        },
      },
    },
  }));
  assert.throws(
    () => assertStagedSnapshotAllowed(expected, actual, stagingAllowance()),
    /staged agent entry does not match frozen target: tasks/,
  );
});

test('staging rejects non-Task plugin contract or plugin-roster drift', () => {
  const expected = baselineSnapshot();
  const changedCodex = collectSnapshot('/bin/openclaw', runnerFor({
    plugins: {
      plugins: basePlugins.plugins.map((plugin) => plugin.id === 'codex'
        ? { ...plugin, version: '2026.9.8' }
        : plugin),
    },
  }));
  assert.throws(
    () => assertStagedSnapshotAllowed(expected, changedCodex, stagingAllowance()),
    /non-staged plugin contract changed during staging: codex/,
  );

  const changedOrigin = collectSnapshot('/bin/openclaw', runnerFor({
    plugins: {
      plugins: basePlugins.plugins.map((plugin) => plugin.id === 'codex'
        ? { ...plugin, origin: 'bundled' }
        : plugin),
    },
  }));
  assert.throws(
    () => assertStagedSnapshotAllowed(expected, changedOrigin, stagingAllowance()),
    /external plugin roster during staging changed/,
  );
});
