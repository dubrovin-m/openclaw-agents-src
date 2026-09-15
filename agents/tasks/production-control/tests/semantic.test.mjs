import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-production-semantic-'));
process.env.OPC_STATE_DIR = root;
process.env.OPC_INSTALLED_REVISION_FILE = path.join(root, 'installed-revision');

const controller = await import(`../controller.mjs?semantic-test=${Date.now()}`);
const binding = {
  control_repository: 'owner/control',
  implementation_repository: 'owner/source',
  control_issue: 7,
  owner_login: 'owner',
  owner_id: 123,
};

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('semantic request ids are numeric, unique, and independent from GitHub comment ids', () => {
  const state = { requests: { '1700000000000': { source: 'semantic' } } };
  assert.equal(controller.allocateSemanticRequestId(state, () => 1700000000000), 1700000000001);
  assert.equal(controller.recordAdvancesGitHubWatermark({ source: 'semantic' }), false);
  assert.equal(controller.recordAdvancesGitHubWatermark({ source: 'github' }), true);
  assert.equal(controller.recordAdvancesGitHubWatermark({}), true, 'legacy records remain GitHub-sourced');
});

test('semantic status exposes bounded controller facts without raw request payloads', () => {
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({
    version: 1,
    ...binding,
    mode: 'ACTIVE',
    deployment_blocked: false,
    block_reason: null,
    controller_revision: '1'.repeat(40),
    production_baseline_sha: '2'.repeat(40),
    last_diagnostic: { ok: true, checked_at: '2026-09-02T18:00:00.000Z', request_id: 42, secret: 'must-not-leak' },
    requests: {
      '99': { type: 'deploy', source: 'semantic', sha: '3'.repeat(40), state: 'IN_PROGRESS', unit: 'hidden-unit', reason: 'hidden-reason' },
    },
  }, null, 2));

  const result = controller.getSemanticStatus();
  assert.deepEqual(result.active_request, {
    id: 99,
    type: 'deploy',
    source: 'semantic',
    sha: '3'.repeat(40),
    state: 'IN_PROGRESS',
  });
  assert.deepEqual(result.last_diagnostic, {
    ok: true,
    checked_at: '2026-09-02T18:00:00.000Z',
    request_id: 42,
  });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('hidden-unit'), false);
  assert.equal(JSON.stringify(result).includes(binding.control_repository), false);
});

test('malformed semantic deploy fails before lock or network activity', async () => {
  await assert.rejects(() => controller.requestSemanticDeployment('main'), /exact 40-character lowercase SHA/);
  assert.equal(fs.existsSync(path.join(root, 'controller.lock')), false);
});

test('semantic deployment rejects installed-controller revision drift before deployment work', () => {
  const expected = '4'.repeat(40);
  fs.writeFileSync(path.join(root, 'installed-revision'), `${'5'.repeat(40)}\n`, { mode: 0o600 });
  assert.throws(
    () => controller.assertInstalledControllerRevision({ controller_revision: expected }),
    /does not match bootstrapped revision/,
  );
  fs.writeFileSync(path.join(root, 'installed-revision'), `${expected}\n`, { mode: 0o600 });
  assert.doesNotThrow(() => controller.assertInstalledControllerRevision({ controller_revision: expected }));
});
