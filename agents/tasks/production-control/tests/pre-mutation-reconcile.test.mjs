import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'reconcile-pre-mutation-unknown.sh');
const CONTROLLER = 'a'.repeat(40);
const PROTECTED = 'b'.repeat(40);
const BASELINE = 'c'.repeat(40);
const TARGET = 'd'.repeat(40);
const REQUEST = 7001;
const PREDECESSOR_VERSION = '2026.9.5';
const TARGET_VERSION = '2026.9.7';

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-mutation-reconcile-'));
  const stateDir = path.join(tmp, 'state');
  const libDir = path.join(tmp, 'lib');
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(path.join(stateDir, 'executions'), { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.chmodSync(stateDir, 0o700);
  const revisionFile = path.join(libDir, 'installed-revision');
  fs.writeFileSync(revisionFile, `${CONTROLLER}\n`, { mode: 0o600 });
  const backup = path.join(stateDir, 'backup.tar.gz');
  fs.writeFileSync(backup, 'verified-backup', { mode: 0o600 });
  const backupSha = crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
  const state = {
    version: 1, mode: 'ACTIVE', controller_revision: CONTROLLER,
    protected_path_baseline_sha: PROTECTED, production_baseline_sha: BASELINE,
    deployment_blocked: true, block_reason: `request ${REQUEST} ended UNKNOWN`,
    requests: { [REQUEST]: { type: 'rollout-openclaw', source: 'github', sha: TARGET, state: 'UNKNOWN', evidence_error: 'recovery-required evidence is inconsistent' } },
    watermark: REQUEST,
  };
  const stateFile = path.join(stateDir, 'state.json');
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const evidence = {
    request_id: REQUEST, outcome: 'RECOVERY_REQUIRED', block_further_deployments: true,
    stage: 'TASK_PREDEPLOY', reason: 'missing Task evidence', source_revision: TARGET,
    predecessor_openclaw_version: PREDECESSOR_VERSION, target_openclaw_version: TARGET_VERSION,
    mutation_started: false, backup_created: true, backup_archive: backup, backup_sha256: backupSha,
    core_version: PREDECESSOR_VERSION, task_predeploy_result: null, task_predeploy_stage: null,
    task_predeploy_mutation_started: false, task_deploy_result: null, task_deploy_stage: null, task_mutation_started: false,
  };
  fs.writeFileSync(path.join(stateDir, 'executions', `request-${REQUEST}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const systemctl = path.join(binDir, 'systemctl');
  fs.writeFileSync(systemctl, `#!/usr/bin/env bash\nset -euo pipefail\nunit=\${3:-}\ncase "$unit" in openclaw-gateway.service|nexus-sync.timer) echo active; exit 0;; *) echo inactive; exit 3;; esac\n`, { mode: 0o700 });
  const diagnose = path.join(libDir, 'diagnose.mjs');
  fs.writeFileSync(diagnose, `const b=process.env.FAKE_BASELINE,v=process.env.FAKE_VERSION;process.stdout.write(JSON.stringify({ok:true,checks:{runtime:{ok:true,openclaw_version:v,expected_openclaw_version:v},provenance:{ok:true,production_baseline_sha:b,source_revision:b},release:{ok:true}}})+'\\n');\n`, { mode: 0o600 });
  return { tmp, stateDir, libDir, systemctl, diagnose, stateFile };
}

function run(f, apply = false, extraEnv = {}) {
  const args = [SCRIPT, '--request-id', String(REQUEST), '--expected-target-sha', TARGET, '--expected-production-sha', BASELINE,
    '--expected-controller-sha', CONTROLLER, '--expected-protected-sha', PROTECTED, '--expected-openclaw-version', PREDECESSOR_VERSION,
    '--expected-target-openclaw-version', TARGET_VERSION];
  if (apply) args.push('--apply');
  return spawnSync('bash', args, { encoding: 'utf8', env: { ...process.env, OPC_TEST_MODE: '1', OPC_STATE_DIR: f.stateDir, OPC_LIB_DIR: f.libDir, OPC_DIAGNOSE: f.diagnose, OPC_INSTALLED_REVISION_FILE: path.join(f.libDir, 'installed-revision'), OPC_SYSTEMCTL: f.systemctl, FAKE_BASELINE: BASELINE, FAKE_VERSION: PREDECESSOR_VERSION, ...extraEnv } });
}

test('pre-mutation reconciliation rejects diagnostic overrides outside explicit test mode', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const args = [SCRIPT, '--request-id', String(REQUEST), '--expected-target-sha', TARGET, '--expected-production-sha', BASELINE,
    '--expected-controller-sha', CONTROLLER, '--expected-protected-sha', PROTECTED, '--expected-openclaw-version', PREDECESSOR_VERSION,
    '--expected-target-openclaw-version', TARGET_VERSION, '--apply'];
  const result = spawnSync('bash', args, { encoding: 'utf8', env: { ...process.env, OPC_DIAGNOSE: f.diagnose } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /OPC_DIAGNOSE is test-only/);
});

test('pre-mutation reconciliation preflight is read-only and apply clears only the proven block', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const before = fs.readFileSync(f.stateFile, 'utf8');
  const dry = run(f, false);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /PRE_MUTATION_RECONCILIATION_PREFLIGHT_PASS/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  const applied = run(f, true);
  assert.equal(applied.status, 0, applied.stderr);
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.equal(state.deployment_blocked, false);
  assert.equal(state.block_reason, null);
  assert.equal(state.controller_revision, CONTROLLER);
  assert.equal(state.protected_path_baseline_sha, PROTECTED);
  assert.equal(state.production_baseline_sha, BASELINE);
  assert.equal(state.requests[String(REQUEST)].state, 'BLOCKED_PRE_MUTATION');
  assert.equal(state.requests[String(REQUEST)].reconciled_from_state, 'UNKNOWN');
  assert.equal(state.requests[String(REQUEST)].reconciliation.kind, 'proven-pre-mutation-v1');
  assert.match(applied.stdout, /PRE_MUTATION_RECONCILIATION_PASS/);
});

test('pre-mutation reconciliation refuses evidence that reports mutation', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const evidenceFile = path.join(f.stateDir, 'executions', `request-${REQUEST}.json`);
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  evidence.mutation_started = true;
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const result = run(f, true);
  assert.notEqual(result.status, 0);
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.equal(state.deployment_blocked, true);
  assert.equal(state.requests[String(REQUEST)].state, 'UNKNOWN');
});


test('pre-mutation reconciliation restores blocked state on SIGTERM after mutation', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.tmp, { recursive: true, force: true }));
  const before = fs.readFileSync(f.stateFile, 'utf8');
  const counter = path.join(f.tmp, 'diagnose-count');
  fs.writeFileSync(f.diagnose, `import fs from 'node:fs';\nconst counter=process.env.FAKE_DIAG_COUNTER;\nconst n=(fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0)+1;\nfs.writeFileSync(counter,String(n));\nif(n===2) process.kill(process.ppid,'SIGTERM');\nconst b=process.env.FAKE_BASELINE,v=process.env.FAKE_VERSION;process.stdout.write(JSON.stringify({ok:true,checks:{runtime:{ok:true,openclaw_version:v,expected_openclaw_version:v},provenance:{ok:true,production_baseline_sha:b,source_revision:b},release:{ok:true}}})+'\\n');\n`, { mode: 0o600 });
  const result = run(f, true, { FAKE_DIAG_COUNTER: counter });
  assert.equal(result.status, 143, result.stderr);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.equal(state.deployment_blocked, true);
  assert.equal(state.requests[String(REQUEST)].state, 'UNKNOWN');
});
