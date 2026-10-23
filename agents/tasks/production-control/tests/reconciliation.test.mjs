import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-controller-reconciliation-'));
const stateDir = path.join(tmp, 'controller-state');
process.env.OPC_STATE_DIR = stateDir;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { reconcileOperation } = await import('../controller.mjs?reconciliation-test=' + Date.now());

const BASELINE = '1'.repeat(40);
const APPROVED = '2'.repeat(40);
let nextId = 7000;

function fixture({ record = {}, evidence = {}, missingEvidence = false } = {}) {
  const requestId = ++nextId;
  const active = {
    type: 'deploy', source: 'github', state: 'IN_PROGRESS',
    sha: APPROVED, unit: 'synthetic-never-active-' + requestId,
    ...record,
  };
  const state = {
    version: 1, mode: 'ACTIVE',
    production_baseline_sha: BASELINE,
    deployment_blocked: false, block_reason: null,
    requests: { [requestId]: active }, watermark: 0,
  };
  const file = path.join(stateDir, 'executions', 'request-' + requestId + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!missingEvidence) {
    const result = {
      request_id: requestId, operation: active.type, source_revision: active.sha,
      outcome: 'SUCCESS', mutation_started: true,
      block_further_deployments: false, ...evidence,
    };
    fs.writeFileSync(file, JSON.stringify(result), { mode: 0o600 });
  }
  return { requestId, state, record: active, file };
}

function hooks({ diagnosticOk = true, checkoutError = null } = {}) {
  const calls = [];
  return {
    calls,
    prepareCheckout(sha, directory, options) {
      calls.push({ type: 'checkout', sha, directory, options });
      if (checkoutError) throw new Error(checkoutError);
    },
    async diagnoseOperation(id, sha, expected) {
      calls.push({ type: 'diagnostic', id, sha, expected });
      return { ok: diagnosticOk, checks: {} };
    },
  };
}

test('successful frozen-SHA operation advances baseline after passing diagnostics', async () => {
  const f = fixture();
  const h = hooks();
  assert.equal(await reconcileOperation(f.state, h), false);
  assert.equal(f.record.state, 'SUCCESS');
  assert.equal(f.state.production_baseline_sha, APPROVED);
  assert.equal(f.state.deployment_blocked, false);
  assert.equal(f.state.watermark, f.requestId);
  assert.deepEqual(h.calls.map((call) => call.type), ['checkout', 'diagnostic']);
  assert.equal(h.calls[0].sha, APPROVED);
  assert.equal(h.calls[0].options.requireCurrentMain, false);
  assert.equal(h.calls[1].expected, APPROVED);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'))).production_baseline_sha, APPROVED);
});

test('success evidence cannot advance baseline when exact checkout or final diagnostics fail', async () => {
  for (const options of [{ checkoutError: 'target commit missing' }, { diagnosticOk: false }]) {
    const f = fixture();
    const h = hooks(options);
    await reconcileOperation(f.state, h);
    assert.equal(f.record.state, 'BLOCKED_REQUIRES_JUDGMENT');
    assert.equal(f.state.deployment_blocked, true);
    assert.equal(f.state.production_baseline_sha, BASELINE);
    assert.equal(f.state.watermark, f.requestId);
  }
});

test('tampered, malformed or absent evidence cannot advance baseline or reach target checkout', async () => {
  for (const evidence of [
    { request_id: 1 },
    { operation: 'rollout-openclaw' },
    { source_revision: '3'.repeat(40) },
    { block_further_deployments: true },
    { mutation_started: 'yes' },
  ]) {
    const f = fixture({ evidence });
    const h = hooks();
    await reconcileOperation(f.state, h);
    assert.equal(f.record.state, 'UNKNOWN');
    assert.equal(f.state.deployment_blocked, true);
    assert.equal(f.state.production_baseline_sha, BASELINE);
    assert.equal(h.calls.some((call) => call.type === 'checkout'), false);
  }
  const broken = fixture();
  fs.writeFileSync(broken.file, '{not json');
  const brokenHooks = hooks();
  await reconcileOperation(broken.state, brokenHooks);
  assert.equal(broken.record.state, 'UNKNOWN');
  assert.equal(broken.state.production_baseline_sha, BASELINE);
  assert.equal(brokenHooks.calls.some((call) => call.type === 'checkout'), false);

  const missing = fixture({ missingEvidence: true });
  const missingHooks = hooks();
  await reconcileOperation(missing.state, missingHooks);
  assert.equal(missing.record.state, 'UNKNOWN');
  assert.equal(missing.state.deployment_blocked, true);
  assert.equal(missing.state.production_baseline_sha, BASELINE);
  assert.equal(missingHooks.calls.some((call) => call.type === 'checkout'), false);
});

test('invalid accepted SHA cannot pass the evidence identity gate', async () => {
  const f = fixture({ record: { sha: 'not-a-sha' } });
  const h = hooks();
  await reconcileOperation(f.state, h);
  assert.equal(f.record.state, 'UNKNOWN');
  assert.equal(f.state.deployment_blocked, true);
  assert.equal(f.state.production_baseline_sha, BASELINE);
  assert.equal(h.calls.some((call) => call.type === 'checkout'), false);
});

test('real deployment failure and rollback outcomes are not converted into success', async () => {
  for (const terminal of [
    { outcome: 'ROLLED_BACK', mutation_started: true, block_further_deployments: false, blocked: false },
    { outcome: 'BLOCKED_PRE_MUTATION', mutation_started: false, block_further_deployments: false, blocked: false },
    { outcome: 'RECOVERY_REQUIRED', mutation_started: true, block_further_deployments: true, blocked: true },
  ]) {
    const f = fixture({ evidence: terminal });
    const h = hooks();
    await reconcileOperation(f.state, h);
    assert.equal(f.record.state, terminal.outcome);
    assert.equal(f.state.production_baseline_sha, BASELINE);
    assert.equal(f.state.deployment_blocked, terminal.blocked);
    assert.equal(h.calls.some((call) => call.type === 'checkout'), false);
  }
});

test('staged validation claiming mutation remains fail-closed', async () => {
  const f = fixture({ record: { validation_only: true } });
  const h = hooks();
  await reconcileOperation(f.state, h);
  assert.equal(f.record.state, 'UNKNOWN');
  assert.equal(f.state.production_baseline_sha, BASELINE);
  assert.equal(f.state.deployment_blocked, true);
  assert.equal(h.calls.length, 0);
});
