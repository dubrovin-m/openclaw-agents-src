import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProtectedPathBaseline } from '../controller.mjs';
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
  validateOperationEvidence,
  validateOperationalBinding,
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
});

test('requires distinct validated control and implementation bindings', () => {
  assert.deepEqual(validateOperationalBinding(binding), binding);
  assert.throws(() => validateOperationalBinding({ ...binding, implementation_repository: binding.control_repository }), /must be distinct/u);
  assert.throws(() => validateOperationalBinding({ ...binding, control_issue: 0 }), /control issue/u);
});

test('accepts only exact registered commands', () => {
  assert.deepEqual(parseCommand('/diagnose tasks'), { type: 'diagnose' });
  assert.deepEqual(parseCommand('/deploy tasks 0123456789abcdef0123456789abcdef01234567'), { type: 'deploy', sha: '0123456789abcdef0123456789abcdef01234567' });
  assert.deepEqual(parseCommand('/rollout openclaw 0123456789abcdef0123456789abcdef01234567'), { type: 'rollout-openclaw', sha: '0123456789abcdef0123456789abcdef01234567' });
  assert.equal(parseCommand('/exec id'), null);
  assert.equal(parseCommand('/deploy tasks main'), null);
});

test('parses two-parent merge topology and exact merged-main PR provenance', () => {
  const base = '1'.repeat(40), head = '2'.repeat(40), sha = '3'.repeat(40);
  assert.deepEqual(parseGitHubMergeCommit({ parents: [{ sha: base }, { sha: head }] }), { baseParentSha: base, headParentSha: head });
  const valid = { number: 25, merged_at: '2026-09-07T15:31:47Z', base: { ref: 'main' }, head: { sha: head }, merge_commit_sha: sha };
  assert.equal(selectMergedMainPrNumber([valid], sha, head), 25);
  assert.equal(validateMergedMainPr(valid, 25, sha, head), true);
  assert.equal(selectMergedMainPrNumber([{ ...valid, base: { ref: 'release' } }], sha, head), null);
});

test('rejects invalid binding, pre-activation, edited and non-owner comments', () => {
  assert.equal(validateControlComment(comment(), 100).reason, 'invalid-binding');
  assert.equal(validateControlComment(comment({ id: 100 }), 100, binding).reason, 'pre-activation-comment');
  assert.equal(validateControlComment(comment({ updated_at: '2026-08-26T10:01:00Z' }), 100, binding).reason, 'edited-comment');
  assert.equal(validateControlComment(comment({ user: { id: 1, login: 'attacker' } }), 100, binding).reason, 'wrong-author');
  assert.equal(validateControlComment(comment({ body: '/exec uname -a' }), 100, binding).reason, 'unrecognized-command');
  assert.equal(validateControlComment(comment(), 100, binding).ok, true);
});

test('protects executable authority paths without treating docs/tests as authority', () => {
  for (const p of [
    'runtime-contract.json',
    'shared/runtime-contract/runtime-contract.mjs',
    'agents/tasks/production-control/controller.mjs',
    'agents/tasks/production-control/execute-rollout.sh',
    'agents/tasks/production-control/plugin-registry-state.cjs',
    'agents/tasks/deploy.sh',
    'agents/tasks/recover.sh',
    '.github/workflows/task-agent-ci.yml',
  ]) assert.equal(isProtectedDeploymentPath(p), true, p);
  for (const p of [
    'agents/tasks/production-control/README.md',
    'agents/tasks/production-control/tests/core.test.mjs',
    'agents/tasks/production-control/reconcile-break-glass.sh',
    'agents/tasks/production-control/reconcile-baseline-break-glass.sh',
    'agents/tasks/taskctl',
  ]) assert.equal(isProtectedDeploymentPath(p), false, p);
});

test('rollout protects controller and execution semantics but permits the frozen runtime target', () => {
  for (const p of [
    'shared/runtime-contract/runtime-contract.mjs',
    'agents/tasks/production-control/controller.mjs',
    'agents/tasks/production-control/execute-deploy.sh',
    'agents/tasks/deploy.sh',
    'agents/tasks/plugins/taskctl/src/production-control.ts',
    '.github/workflows/task-production-control-ci.yml',
  ]) assert.equal(isRolloutProtectedPath(p), true, p);
  assert.equal(isRolloutProtectedPath('runtime-contract.json'), false);
  assert.equal(isRolloutProtectedPath('agents/tasks/production-control/README.md'), false);
  assert.equal(isRolloutProtectedPath('agents/tasks/production-control/tests/core.test.mjs'), false);
});

test('staged activation admits only bounded validation-only source paths', () => {
  for (const p of [
    'agents/tasks/README.md',
    'agents/tasks/deploy.sh',
    'agents/tasks/production-control/controller.mjs',
    'agents/tasks/production-control/tests/core.test.mjs',
    '.github/workflows/task-production-control-ci.yml',
  ]) assert.equal(isStagedValidationOnlyPath(p), true, p);
  for (const p of ['runtime-contract.json', 'agents/tasks/taskctl', 'agents/tasks/release.json', 'agents/tasks/workspace/AGENTS.md']) {
    assert.equal(isStagedValidationOnlyPath(p), false, p);
  }
});

test('maps deployment evidence fail-closed', () => {
  assert.deepEqual(mapDeployEvidence({ result: 'PASS' }, 0), { outcome: 'SUCCESS', block: false });
  assert.deepEqual(mapDeployEvidence({ result: 'ROLLED_BACK' }, 1), { outcome: 'ROLLED_BACK', block: false });
  assert.deepEqual(mapDeployEvidence({ result: 'BLOCKED', mutation_started: false }, 2), { outcome: 'BLOCKED_PRE_MUTATION', block: false });
  assert.deepEqual(mapDeployEvidence({ result: 'BLOCKED', mutation_started: true }, 2), { outcome: 'RECOVERY_REQUIRED', block: true });
  assert.deepEqual(mapDeployEvidence(null, 2), { outcome: 'UNKNOWN', block: true });
});

test('generic operation evidence binds exact request, operation and implementation revision', () => {
  const sha = 'a'.repeat(40);
  const record = { type: 'rollout-openclaw', sha };
  const success = {
    request_id: 501,
    operation: 'rollout-openclaw',
    source_revision: sha,
    outcome: 'SUCCESS',
    mutation_started: true,
    block_further_deployments: false,
  };
  assert.deepEqual(validateOperationEvidence(record, success, 501), { ok: true, outcome: 'SUCCESS', block: false, reason: null });
  assert.equal(validateOperationEvidence(record, { ...success, source_revision: 'b'.repeat(40) }, 501).ok, false);
  assert.equal(validateOperationEvidence(record, { ...success, operation: 'deploy' }, 501).ok, false);
  assert.equal(validateOperationEvidence(record, { ...success, request_id: 502 }, 501).ok, false);
});

test('generic terminal evidence enforces fail-closed post-mutation semantics', () => {
  const record = { type: 'deploy', sha: 'a'.repeat(40) };
  const base = { request_id: 7, operation: 'deploy', source_revision: record.sha };
  assert.equal(validateOperationEvidence(record, { ...base, outcome: 'BLOCKED_PRE_MUTATION', mutation_started: false, block_further_deployments: false }, 7).ok, true);
  assert.equal(validateOperationEvidence(record, { ...base, outcome: 'BLOCKED_REQUIRES_JUDGMENT', mutation_started: false, block_further_deployments: false }, 7).ok, true);
  assert.equal(validateOperationEvidence(record, { ...base, outcome: 'BLOCKED_REQUIRES_JUDGMENT', mutation_started: true, block_further_deployments: false }, 7).ok, false);
  assert.equal(validateOperationEvidence(record, { ...base, outcome: 'RECOVERY_REQUIRED', mutation_started: true, block_further_deployments: true }, 7).ok, true);
  assert.equal(validateOperationEvidence(record, { ...base, outcome: 'UNKNOWN', mutation_started: true, block_further_deployments: false }, 7).ok, false);
});
