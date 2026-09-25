import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREDECESSOR_WORKSPACE_FILES,
  validatePredecessorBinding,
} from '../verify-release-predecessor.mjs';

const SOURCE = 'a'.repeat(40);
const WORKSPACE_SOURCE = 'e'.repeat(40);
const WORKSPACE_HASH = 'b'.repeat(64);
const TOOLS_HASH = 'c'.repeat(64);
const workspace = Object.fromEntries(PREDECESSOR_WORKSPACE_FILES.map((file) => [file, WORKSPACE_HASH]));
const predecessorPlugin = {
  name: 'openclaw-plugin-taskctl',
  version: '0.4.27',
  artifact: 'artifacts/openclaw-plugin-taskctl-0.4.27.tgz',
  sha256: 'd'.repeat(64),
};
const predecessorRelease = {
  format: 'task-agent-release-v2',
  generation: { sqlite_schema: 9, taskctl_version: '0.4.14' },
  plugin: predecessorPlugin,
};
const release = {
  plugin: { ...predecessorPlugin },
  from: {
    source_revision: SOURCE,
    sqlite_schemas: [9],
    taskctl_versions: ['0.4.14'],
    plugin_versions: ['0.4.27'],
    workspace_sha256: workspace,
    tools_sha256: TOOLS_HASH,
  },
};

test('binds the single supported predecessor identities and fingerprints to one exact source revision', () => {
  assert.equal(validatePredecessorBinding({
    release,
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), true);
});

test('binds an explicitly declared workspace overlay to its own exact revision', () => {
  const overlayRelease = {
    ...release,
    from: { ...release.from, workspace_source_revision: WORKSPACE_SOURCE },
  };
  assert.equal(validatePredecessorBinding({
    release: overlayRelease,
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSourceRevision: WORKSPACE_SOURCE,
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), true);
  assert.throws(() => validatePredecessorBinding({
    release: overlayRelease,
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSourceRevision: SOURCE,
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), /workspace source revision mismatch/u);
});

test('rejects predecessor source, tool-policy, and workspace drift', () => {
  assert.throws(() => validatePredecessorBinding({
    release,
    predecessorRelease,
    sourceRevision: 'd'.repeat(40),
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), /source revision mismatch/u);
  assert.throws(() => validatePredecessorBinding({
    release,
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSha256: workspace,
    toolsSha256: 'd'.repeat(64),
  }), /tool-policy fingerprint mismatch/u);
  assert.throws(() => validatePredecessorBinding({
    release,
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSha256: { ...workspace, 'AGENTS.md': 'd'.repeat(64) },
    toolsSha256: TOOLS_HASH,
  }), /workspace fingerprint mismatch/u);
});

test('same plugin version is allowed only as exact frozen artifact reuse', () => {
  assert.equal(validatePredecessorBinding({
    release,
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), true);

  for (const plugin of [
    { ...predecessorPlugin, sha256: 'e'.repeat(64) },
    { ...predecessorPlugin, artifact: 'artifacts/openclaw-plugin-taskctl-repacked.tgz' },
    { ...predecessorPlugin, name: 'different-plugin' },
  ]) {
    assert.throws(() => validatePredecessorBinding({
      release: { ...release, plugin },
      predecessorRelease,
      sourceRevision: SOURCE,
      workspaceSha256: workspace,
      toolsSha256: TOOLS_HASH,
    }), /same-version target plugin must reuse exact predecessor plugin artifact identity/u);
  }
});

test('rejects any predecessor identity widening', () => {
  assert.throws(() => validatePredecessorBinding({
    release: { ...release, from: { ...release.from, plugin_versions: ['0.4.26', '0.4.27'] } },
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), /exactly one supported predecessor|plugin identity is not bound/u);

  assert.throws(() => validatePredecessorBinding({
    release: { ...release, from: { ...release.from, sqlite_schemas: [8, 9] } },
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), /SQLite identity is not bound/u);

  assert.throws(() => validatePredecessorBinding({
    release: { ...release, from: { ...release.from, taskctl_versions: ['0.4.13', '0.4.14'] } },
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), /taskctl identity is not bound/u);
});
