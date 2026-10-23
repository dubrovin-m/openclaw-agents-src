import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedTargetStatePatch } from '../controller.mjs';
import { validateOperationEvidence } from '../lib.mjs';

const APPROVED = '2'.repeat(40);
const PREDECESSOR = '1'.repeat(40);
const REQUEST = 7001;
const record = { type: 'deploy', sha: APPROVED };
const success = {
  request_id: REQUEST, operation: 'deploy', source_revision: APPROVED,
  outcome: 'SUCCESS', mutation_started: true, block_further_deployments: false,
};

test('valid accepted SHA and passing target diagnostics yield only the expected baseline update', () => {
  assert.equal(validateOperationEvidence(record, success, REQUEST).ok, true);
  const patch = confirmedTargetStatePatch(record, { ok: true });
  assert.deepEqual(patch, { production_baseline_sha: APPROVED });
  const state = { production_baseline_sha: PREDECESSOR, mode: 'ACTIVE', deployment_blocked: false };
  Object.assign(state, patch);
  assert.equal(state.production_baseline_sha, APPROVED);
  assert.equal(state.deployment_blocked, false);
});

test('baseline decision remains closed for failed diagnostics or invalid accepted SHA', () => {
  assert.equal(confirmedTargetStatePatch(record, { ok: false }), null);
  assert.equal(confirmedTargetStatePatch(record, null), null);
  assert.equal(confirmedTargetStatePatch({ ...record, sha: 'invalid' }, { ok: true }), null);
  assert.equal(confirmedTargetStatePatch({ ...record, sha: '3'.repeat(39) }, { ok: true }), null);
});

test('staged validation only activates when the exact target is confirmed', () => {
  const accepted = { ...record, validation_only: true };
  assert.deepEqual(confirmedTargetStatePatch(accepted, { ok: true }, '2026-10-23T00:00:00.000Z'), {
    production_baseline_sha: APPROVED,
    mode: 'ACTIVE',
    activated_at: '2026-10-23T00:00:00.000Z',
  });
  assert.equal(confirmedTargetStatePatch(accepted, { ok: false }), null);
});

test('corrupt evidence remains UNKNOWN and cannot authorize success reconciliation', () => {
  for (const altered of [
    { request_id: REQUEST + 1 },
    { operation: 'rollout-openclaw' },
    { source_revision: '3'.repeat(40) },
    { mutation_started: 'yes' },
    { block_further_deployments: true },
  ]) {
    const terminal = validateOperationEvidence(record, { ...success, ...altered }, REQUEST);
    assert.equal(terminal.ok, false);
    assert.equal(terminal.outcome, 'UNKNOWN');
    assert.equal(terminal.block, true);
  }
  const terminal = validateOperationEvidence(record, null, REQUEST);
  assert.equal(terminal.ok, false);
  assert.equal(terminal.block, true);
});

test('genuine failed execution outcomes retain their fail-closed classification', () => {
  for (const [outcome, mutation_started, block_further_deployments] of [
    ['BLOCKED_PRE_MUTATION', false, false],
    ['ROLLED_BACK', true, false],
    ['RECOVERY_REQUIRED', true, true],
  ]) {
    const terminal = validateOperationEvidence(record, {
      ...success, outcome, mutation_started, block_further_deployments,
    }, REQUEST);
    assert.equal(terminal.ok, true);
    assert.equal(terminal.outcome, outcome);
    assert.notEqual(terminal.outcome, 'SUCCESS');
  }
});
