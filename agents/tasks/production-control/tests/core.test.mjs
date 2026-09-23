import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveProtectedPathBaseline, verifyRolloutBackupArtifact } from '../controller.mjs';
import {
  isProtectedDeploymentPath,
  isRolloutProtectedPath,
  isStagedValidationOnlyPath,
  mapDeployEvidence,
  parseCommand,
  parseGitHubMergeCommit,
  selectMergedMainPrNumber,
  validateControlComment,
  validateMergedMainPr,
  validateOperationalBinding,
  validateRolloutEvidence,
} from '../lib.mjs';

const binding = {
  control_repository: 'owner/control',
  implementation_repository: 'owner/source',
  control_issue: 7,
  owner_login: 'owner',
  owner_id: 123,
};

const comment = (overrides = {}) => ({
  id: 101,
  body: '/diagnose tasks',
  created_at: '2026-08-26T10:00:00Z',
  updated_at: '2026-08-26T10:00:00Z',
  user: { id: binding.owner_id, login: binding.owner_login },
  ...overrides,
});

test('protected-path baseline is independent and legacy state falls back only when the field is absent', () => {
  const controller = '1'.repeat(40);
  const protectedBaseline = '2'.repeat(40);
  assert.equal(resolveProtectedPathBaseline({ controller_revision: controller, protected_path_baseline_sha: protectedBaseline }), protectedBaseline);
  assert.equal(resolveProtectedPathBaseline({ controller_revision: controller }), controller);
  assert.throws(() => resolveProtectedPathBaseline({ controller_revision: controller, protected_path_baseline_sha: null }), /protected-path baseline/u);
  assert.throws(() => resolveProtectedPathBaseline({ controller_revision: controller, protected_path_baseline_sha: 'invalid' }), /protected-path baseline/u);
});

test('requires distinct validated control and implementation bindings', () => {
  assert.deepEqual(validateOperationalBinding(binding), binding);
  assert.throws(() => validateOperationalBinding({ ...binding, implementation_repository: binding.control_repository }), /must be distinct/u);
  assert.throws(() => validateOperationalBinding({ ...binding, control_issue: 0 }), /control issue/u);
  assert.throws(() => validateOperationalBinding({ ...binding, owner_id: 0 }), /owner id/u);
});

test('accepts only exact registered commands', () => {
  assert.deepEqual(parseCommand('/diagnose tasks'), { type: 'diagnose' });
  assert.deepEqual(parseCommand('/deploy tasks 0123456789abcdef0123456789abcdef01234567'), {
    type: 'deploy',
    sha: '0123456789abcdef0123456789abcdef01234567',
  });
  assert.deepEqual(parseCommand('/rollout openclaw 0123456789abcdef0123456789abcdef01234567'), {
    type: 'rollout-openclaw',
    sha: '0123456789abcdef0123456789abcdef01234567',
  });
  assert.equal(parseCommand('/rollout openclaw main'), null);
  assert.equal(parseCommand('/deploy tasks main'), null);
  assert.equal(parseCommand('/exec id'), null);
  assert.equal(parseCommand('/diagnose main'), null);
  assert.equal(parseCommand('/deploy tasks 0123'), null);
});

test('parses two-parent merge topology independently of commit message', () => {
  const base = '1111111111111111111111111111111111111111';
  const head = '2222222222222222222222222222222222222222';
  const expected = { baseParentSha: base, headParentSha: head };
  assert.deepEqual(parseGitHubMergeCommit({
    commit: { message: 'Merge pull request #25 from example/fix/task-controller\n\nFix provenance' },
    parents: [{ sha: base }, { sha: head }],
  }), expected);
  assert.deepEqual(parseGitHubMergeCommit({
    commit: { message: 'Merge PR #25: custom title' },
    parents: [{ sha: base }, { sha: head }],
  }), expected);
  assert.deepEqual(parseGitHubMergeCommit({
    commit: { message: 'arbitrary human-authored merge text' },
    parents: [{ sha: base }, { sha: head }],
  }), expected);
  assert.equal(parseGitHubMergeCommit({
    commit: { message: 'Merge pull request #25 from example/fix/task-controller' },
    parents: [{ sha: base }],
  }), null);
  assert.equal(parseGitHubMergeCommit({
    parents: [{ sha: base }, { sha: head }, { sha: '3333333333333333333333333333333333333333' }],
  }), null);
});

test('requires exact merged-main PR metadata for merge provenance', () => {
  const sha = '3333333333333333333333333333333333333333';
  const head = '2222222222222222222222222222222222222222';
  const valid = {
    number: 25,
    merged_at: '2026-09-07T15:31:47Z',
    base: { ref: 'main' },
    head: { sha: head },
    merge_commit_sha: sha,
  };
  assert.equal(selectMergedMainPrNumber([valid], sha, head), 25);
  assert.equal(validateMergedMainPr(valid, 25, sha, head), true);
  assert.equal(selectMergedMainPrNumber([{ ...valid, merge_commit_sha: '4'.repeat(40) }], sha, head), null);
  assert.equal(selectMergedMainPrNumber([{ ...valid, base: { ref: 'release' } }], sha, head), null);
  assert.equal(selectMergedMainPrNumber([{ ...valid, head: { sha: '5'.repeat(40) } }], sha, head), null);
  assert.equal(selectMergedMainPrNumber([{ ...valid, merged_at: null }], sha, head), null);
  assert.equal(selectMergedMainPrNumber([valid, { ...valid, number: 26 }], sha, head), null);
  assert.equal(validateMergedMainPr(valid, 26, sha, head), false);
});

test('rejects invalid binding, pre-activation, edited and non-owner comments', () => {
  assert.equal(validateControlComment(comment(), 100).reason, 'invalid-binding');
  assert.equal(validateControlComment(comment({ id: 100 }), 100, binding).reason, 'pre-activation-comment');
  assert.equal(validateControlComment(comment({ updated_at: '2026-08-26T10:01:00Z' }), 100, binding).reason, 'edited-comment');
  assert.equal(validateControlComment(comment({ user: { id: 1, login: 'attacker' } }), 100, binding).reason, 'wrong-author');
  assert.equal(validateControlComment(comment({ body: '/exec uname -a' }), 100, binding).reason, 'unrecognized-command');
  assert.equal(validateControlComment(comment(), 100, binding).ok, true);
});

test('protects controller, runtime contract, and deployment harness paths', () => {
  for (const p of [
    'runtime-contract.json',
    'shared/runtime-contract/runtime-contract.mjs',
    'agents/tasks/production-control/controller.mjs',
    'agents/tasks/deploy.sh',
    'agents/tasks/recover.sh',
    'agents/tasks/install.sh',
    'agents/tasks/workspace-layout.mjs',
    '.github/workflows/task-agent-ci.yml',
  ]) assert.equal(isProtectedDeploymentPath(p), true, p);
  assert.equal(isProtectedDeploymentPath('agents/tasks/taskctl'), false);
  assert.equal(isProtectedDeploymentPath('agents/tasks/workspace/AGENTS.md'), false);
});

test('rollout protects controller and execution semantics but permits the frozen runtime target', () => {
  for (const p of [
    'shared/runtime-contract/runtime-contract.mjs',
    'agents/tasks/production-control/controller.mjs',
    'agents/tasks/deploy.sh',
    'agents/tasks/recover.sh',
    'agents/tasks/plugins/taskctl/src/production-control.ts',
    '.github/workflows/task-production-control-ci.yml',
    '.github/workflows/engineer-agent-ci.yml',
  ]) assert.equal(isRolloutProtectedPath(p), true, p);
  assert.equal(isRolloutProtectedPath('runtime-contract.json'), false);
  assert.equal(isRolloutProtectedPath('agents/tasks/release.json'), false);
});

test('staged controller activation admits only bounded validation-only source paths', () => {
  for (const p of [
    'agents/tasks/README.md',
    'agents/tasks/deploy.sh',
    'agents/tasks/tests/deploy.sh',
    'agents/tasks/production-control/controller.mjs',
    '.github/workflows/task-production-control-ci.yml',
    '.github/workflows/task-agent-ci.yml',
  ]) assert.equal(isStagedValidationOnlyPath(p), true, p);
  for (const p of [
    'runtime-contract.json',
    'shared/runtime-contract/runtime-contract.mjs',
    'agents/tasks/taskctl',
    'agents/tasks/release.json',
    'agents/tasks/workspace/AGENTS.md',
    'agents/tasks/workspace-layout.mjs',
    'agents/tasks/config/tasks-tools.json',
    'agents/tasks/recover.sh',
    'agents/tasks/install.sh',
    'agents/tasks/plugins/taskctl/src/index.ts',
  ]) assert.equal(isStagedValidationOnlyPath(p), false, p);
});

test('maps deployment evidence fail-closed', () => {
  assert.deepEqual(mapDeployEvidence({ result: 'PASS' }, 0), { outcome: 'SUCCESS', block: false });
  assert.deepEqual(mapDeployEvidence({ result: 'ROLLED_BACK' }, 1), { outcome: 'ROLLED_BACK', block: false });
  assert.deepEqual(mapDeployEvidence({ result: 'BLOCKED', mutation_started: false }, 2), { outcome: 'BLOCKED_PRE_MUTATION', block: false });
  assert.deepEqual(mapDeployEvidence({ result: 'BLOCKED', mutation_started: true }, 2), { outcome: 'RECOVERY_REQUIRED', block: true });
  assert.deepEqual(mapDeployEvidence(null, 2), { outcome: 'UNKNOWN', block: true });
});

test('validates rollout durable evidence against the exact frozen request', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const record = {
    sha,
    predecessor_openclaw_version: '2026.8.2',
    target_openclaw_version: '2026.9.1',
  };
  const success = {
    request_id: 501,
    outcome: 'SUCCESS',
    block_further_deployments: false,
    stage: 'COMPLETE',
    source_revision: sha,
    predecessor_openclaw_version: '2026.8.2',
    target_openclaw_version: '2026.9.1',
    mutation_started: true,
    backup_created: true,
    backup_archive: '/private/recovery/request-501/backup.tar.gz',
    backup_sha256: 'a'.repeat(64),
    core_version: '2026.9.1',
    gateway_ready: true,
    codex_version: '2026.9.1',
    task_deploy_result: 'PASS',
    task_deploy_stage: 'COMPLETE',
  };
  assert.deepEqual(validateRolloutEvidence(record, success, 501), { ok: true, outcome: 'SUCCESS', block: false, reason: null });
  assert.equal(validateRolloutEvidence(record, { ...success, source_revision: 'f'.repeat(40) }, 501).ok, false);
  assert.equal(validateRolloutEvidence(record, { ...success, backup_sha256: null }, 501).ok, false);
  assert.equal(validateRolloutEvidence(record, { ...success, target_openclaw_version: '2026.9.2' }, 501).ok, false);
});

test('post-mutation judgment evidence must block later production changes', () => {
  const record = {
    sha: '0123456789abcdef0123456789abcdef01234567',
    predecessor_openclaw_version: '2026.8.2',
    target_openclaw_version: '2026.9.1',
  };
  const evidence = {
    request_id: 502,
    outcome: 'BLOCKED_REQUIRES_JUDGMENT',
    block_further_deployments: false,
    source_revision: record.sha,
    predecessor_openclaw_version: record.predecessor_openclaw_version,
    target_openclaw_version: record.target_openclaw_version,
    mutation_started: true,
  };
  const invalid = validateRolloutEvidence(record, evidence, 502);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.outcome, 'UNKNOWN');
  assert.equal(invalid.block, true);
  assert.equal(validateRolloutEvidence(record, { ...evidence, block_further_deployments: true }, 502).ok, true);
});

test('reconciliation requires the retained owner-only backup artifact and matching digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-rollout-backup-'));
  try {
    const requestId = 601;
    const recovery = path.join(root, 'recovery', `request-${requestId}`);
    fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
    const archive = path.join(recovery, 'backup.tar.gz');
    const bytes = Buffer.from('verified-backup-fixture');
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
    fs.chmodSync(archive, 0o600);
    const backup_sha256 = createHash('sha256').update(bytes).digest('hex');
    const evidence = { backup_archive: archive, backup_sha256 };
    assert.deepEqual(verifyRolloutBackupArtifact(root, requestId, evidence), { ok: true, reason: null });

    fs.writeFileSync(archive, 'tampered');
    assert.equal(verifyRolloutBackupArtifact(root, requestId, evidence).ok, false);
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
    fs.chmodSync(archive, 0o644);
    assert.equal(verifyRolloutBackupArtifact(root, requestId, evidence).ok, false);

    const outside = path.join(root, 'outside.tar.gz');
    fs.writeFileSync(outside, bytes, { mode: 0o600 });
    assert.equal(verifyRolloutBackupArtifact(root, requestId, { backup_archive: outside, backup_sha256 }).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
