import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREDECESSOR_WORKSPACE_FILES,
  sha256,
  stableJson,
  validatePredecessorBinding,
  validatePublicBootstrapBridge,
} from '../verify-release-predecessor.mjs';

const SOURCE = 'a'.repeat(40);
const WORKSPACE_SOURCE = 'e'.repeat(40);
const WORKSPACE_HASH = 'b'.repeat(64);
const TOOLS_HASH = 'c'.repeat(64);
const workspace = Object.fromEntries(PREDECESSOR_WORKSPACE_FILES.map((file) => [file, WORKSPACE_HASH]));
const predecessorRelease = {
  format: 'task-agent-release-v2',
  generation: { sqlite_schema: 5, taskctl_version: '0.4.5' },
  plugin: { version: '0.4.13' },
};
const release = {
  plugin: { version: '0.4.14' },
  from: {
    source_revision: SOURCE,
    sqlite_schemas: [5],
    taskctl_versions: ['0.4.5'],
    plugin_versions: ['0.4.13'],
    workspace_sha256: workspace,
    tools_sha256: TOOLS_HASH,
  },
};

test('binds predecessor identities and fingerprints to one exact source revision by default', () => {
  assert.equal(validatePredecessorBinding({
    release,
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), true);
});

test('binds a source-owned workspace overlay to its own exact revision', () => {
  const overlayRelease = {
    ...release,
    from: {
      ...release.from,
      workspace_source_revision: WORKSPACE_SOURCE,
    },
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

test('rejects predecessor fingerprint and source drift', () => {
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

test('rejects predecessor identity widening beyond the exact source release', () => {
  assert.throws(() => validatePredecessorBinding({
    release: { ...release, from: { ...release.from, plugin_versions: ['0.4.12', '0.4.13'] } },
    predecessorRelease,
    sourceRevision: SOURCE,
    workspaceSha256: workspace,
    toolsSha256: TOOLS_HASH,
  }), /plugin identity is not bound/u);
});

test('a release without a predecessor must explicitly retire source provenance', () => {
  assert.equal(validatePredecessorBinding({
    release: { plugin: { version: '0.4.14' }, from: { source_revision: null, plugin_versions: [] } },
    predecessorRelease: null,
    sourceRevision: null,
    workspaceSourceRevision: null,
    workspaceSha256: {},
    toolsSha256: null,
  }), true);
  assert.throws(() => validatePredecessorBinding({
    release: { plugin: { version: '0.4.14' }, from: { source_revision: SOURCE, plugin_versions: [] } },
    predecessorRelease: null,
    sourceRevision: null,
    workspaceSourceRevision: null,
    workspaceSha256: {},
    toolsSha256: null,
  }), /retired predecessor source revision remains/u);
  assert.throws(() => validatePredecessorBinding({
    release: { plugin: { version: '0.4.14' }, from: { source_revision: null, workspace_source_revision: WORKSPACE_SOURCE, plugin_versions: [] } },
    predecessorRelease: null,
    sourceRevision: null,
    workspaceSourceRevision: null,
    workspaceSha256: {},
    toolsSha256: null,
  }), /retired predecessor workspace source revision remains/u);
});


test('public bootstrap bridge is pinned to one exact clean-history release and predecessor', () => {
  const bootstrapRelease = {
    generation: { taskctl_version: '0.4.7', sqlite_schema: 6 },
    plugin: { version: '0.4.17' },
    from: {
      source_revision: SOURCE,
      workspace_source_revision: SOURCE,
      plugin_versions: ['0.4.16'],
    },
  };
  const marker = {
    format: 'task-agent-public-source-bootstrap-v1',
    target: {
      plugin_version: '0.4.17',
      taskctl_version: '0.4.7',
      sqlite_schema: 6,
      release_sha256: sha256(stableJson(bootstrapRelease)),
    },
    legacy_predecessor: {
      source_revision: SOURCE,
      workspace_source_revision: SOURCE,
    },
    public_snapshot: {
      commit: 'd'.repeat(40),
      tree: 'e'.repeat(40),
      parent: 'f'.repeat(40),
    },
    historical_test_revisions: {
      batch7_schema4_source_revision: 'c'.repeat(40),
    },
  };
  assert.equal(validatePublicBootstrapBridge({ release: bootstrapRelease, marker }), true);
  assert.throws(() => validatePublicBootstrapBridge({
    release: { ...bootstrapRelease, plugin: { version: '0.4.18' } },
    marker,
  }), /target plugin mismatch/u);
  assert.throws(() => validatePublicBootstrapBridge({
    release: { ...bootstrapRelease, from: { ...bootstrapRelease.from, source_revision: 'b'.repeat(40) } },
    marker,
  }), /release fingerprint mismatch|predecessor revision mismatch/u);
  assert.throws(() => validatePublicBootstrapBridge({
    release: bootstrapRelease,
    marker: { ...marker, public_snapshot: { ...marker.public_snapshot, tree: 'not-a-sha' } },
  }), /snapshot identity is invalid/u);
  assert.throws(() => validatePublicBootstrapBridge({
    release: bootstrapRelease,
    marker: { ...marker, historical_test_revisions: { batch7_schema4_source_revision: 'not-a-sha' } },
  }), /historical test revision is invalid/u);
});
