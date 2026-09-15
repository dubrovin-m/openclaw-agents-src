import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const runtimeContract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'runtime-contract.json'), 'utf8'));
const expectedOpenClawVersion = runtimeContract.openclaw.version;

test('diagnostics fail closed on runtime, release, and provenance drift without exposing secrets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-diagnose-'));
  const home = path.join(root, 'home');
  const openclaw = path.join(home, '.openclaw');
  const bin = path.join(root, 'bin');
  const source = path.join(root, 'source');
  const controllerState = path.join(root, 'controller-state.json');
  const installedRevision = path.join(root, 'installed-revision');
  const controllerRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const priorEnv = new Map();
  const setEnv = (name, value) => {
    priorEnv.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
    process.env[name] = value;
  };

  mkdir(path.join(openclaw, 'data', 'tasks'));
  mkdir(path.join(openclaw, 'extensions', 'taskctl', 'node_modules', 'typebox'));
  mkdir(path.join(openclaw, 'workspace', 'deliverables'));
  mkdir(path.join(home, '.local', 'bin'));
  mkdir(path.join(source, 'agents', 'tasks'));
  mkdir(bin);

  const dbPath = path.join(openclaw, 'data', 'tasks', 'tasks.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA user_version=4; CREATE TABLE synthetic(id INTEGER PRIMARY KEY, secret TEXT); INSERT INTO synthetic(secret) VALUES (\'TASK-SECRET-CONTENT\');');
  db.close();

  const taskctl = path.join(home, '.local', 'bin', 'taskctl');
  const writeTaskctl = (version) => fs.writeFileSync(taskctl, `const IMPLEMENTATION_VERSION = '${version}';\nconst SCHEMA_VERSION = 4;\n`);
  writeTaskctl('0.4.0');
  fs.chmodSync(taskctl, 0o700);

  const pluginPackage = path.join(openclaw, 'extensions', 'taskctl', 'package.json');
  const typeboxPackage = path.join(openclaw, 'extensions', 'taskctl', 'node_modules', 'typebox', 'package.json');
  const writePlugin = (version, typebox = '1.3.15', openclawCompat = '>=2026.8.2', buildVersion = expectedOpenClawVersion) => {
    fs.writeFileSync(pluginPackage, JSON.stringify({ name: 'openclaw-plugin-taskctl', version, peerDependencies: { openclaw: openclawCompat }, openclaw: { compat: { pluginApi: openclawCompat }, build: { openclawVersion: buildVersion } } }));
    fs.writeFileSync(typeboxPackage, JSON.stringify({ version: typebox }));
  };
  writePlugin('0.4.0');

  const configPath = path.join(openclaw, 'openclaw.json');
  const currentConfig = { plugins: { allow: ['taskctl'], secret: 'CONFIG-SECRET-CONTENT' }, agents: { entries: { tasks: {} } } };
  fs.writeFileSync(configPath, JSON.stringify(currentConfig));

  const release = {
    format: 'task-agent-release-v2',
    generation: {
      taskctl_version: '0.4.0',
      sqlite_schema: 4,
      openclaw_build_version: expectedOpenClawVersion,
      openclaw_compat: '>=2026.8.2',
      typebox_version: '1.3.15',
    },
    plugin: { name: 'openclaw-plugin-taskctl', version: '0.4.0' },
  };
  fs.writeFileSync(path.join(source, 'agents', 'tasks', 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: source });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source });
  execFileSync('git', ['config', 'user.name', 'Runtime Contract Test'], { cwd: source });
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: source });
  const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

  fs.writeFileSync(controllerState, `${JSON.stringify({ controller_revision: controllerRevision, production_baseline_sha: baseline })}\n`);
  fs.writeFileSync(installedRevision, `${controllerRevision}\n`);
  const baselineEvidence = path.join(openclaw, 'workspace', 'deliverables', 'task-agent-deploy-baseline-result.json');
  fs.writeFileSync(baselineEvidence, JSON.stringify({ source_revision: baseline, result: 'PASS', stage: 'COMPLETE' }));

  const systemctl = path.join(bin, 'systemctl');
  fs.writeFileSync(systemctl, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(systemctl, 0o700);
  const openclawCli = path.join(bin, 'openclaw');
  const writeOpenClaw = (version) => {
    fs.writeFileSync(openclawCli, `#!/bin/sh\n[ "$1" = "--version" ] || exit 2\nprintf 'OpenClaw ${version}\\n'\n`);
    fs.chmodSync(openclawCli, 0o700);
  };
  writeOpenClaw(expectedOpenClawVersion);

  setEnv('OPC_HOME', home);
  setEnv('PATH', `${bin}:${process.env.PATH}`);
  setEnv('OPC_CONTROLLER_STATE', controllerState);
  setEnv('OPC_SOURCE_DIR', source);
  setEnv('OPC_INSTALLED_REVISION', installedRevision);
  setEnv('OPC_RUNTIME_CONTRACT', path.join(repoRoot, 'runtime-contract.json'));
  setEnv('OPC_RUNTIME_CONTRACT_HELPER', path.join(repoRoot, 'shared', 'runtime-contract', 'runtime-contract.mjs'));
  setEnv('OPC_OPENCLAW_BIN', openclawCli);

  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(18789, '127.0.0.1', resolve);
  });
  try {
    const loadDiagnose = async () => (await import(`../diagnose.mjs?test=${Date.now()}-${Math.random()}`)).diagnose;

    let diagnose = await loadDiagnose();
    let result = await diagnose();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.runtime.openclaw_version, expectedOpenClawVersion);
    assert.equal(result.checks.release.baseline_sha, baseline);
    assert.equal(result.checks.provenance.source_revision, baseline);

    fs.writeFileSync(configPath, JSON.stringify({ plugins: { allow: ['taskctl'] }, agents: { list: [{ id: 'tasks' }] } }));
    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.config.task_agent_present, true);
    fs.writeFileSync(configPath, JSON.stringify(currentConfig));

    writeTaskctl('0.4.1');
    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.checks.taskctl.ok, true, JSON.stringify(result));
    assert.equal(result.checks.release.ok, false, JSON.stringify(result));
    assert.equal(result.ok, false, JSON.stringify(result));
    writeTaskctl('0.4.0');

    writePlugin('0.4.5');
    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.checks.plugin.ok, true, JSON.stringify(result));
    assert.equal(result.checks.release.ok, false, JSON.stringify(result));
    writePlugin('0.4.0');

    writePlugin('0.4.0', '1.3.16');
    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.checks.release.ok, false, JSON.stringify(result));
    writePlugin('0.4.0');

    writePlugin('0.4.0', '1.3.15', '>=2026.9.0');
    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.checks.release.ok, false, JSON.stringify(result));
    writePlugin('0.4.0');

    const compatibleRuntimeContract = path.join(root, 'runtime-contract-compatible-patch.json');
    const compatibleContract = JSON.parse(JSON.stringify(runtimeContract));
    compatibleContract.openclaw.version = '2026.8.3';
    fs.writeFileSync(compatibleRuntimeContract, JSON.stringify(compatibleContract));
    process.env.OPC_RUNTIME_CONTRACT = compatibleRuntimeContract;
    writeOpenClaw('2026.8.3');
    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.release.expected.openclaw_build_version, expectedOpenClawVersion);
    assert.equal(result.checks.release.expected.openclaw_compat, '>=2026.8.2');
    assert.equal(result.checks.runtime.openclaw_version, '2026.8.3');
    process.env.OPC_RUNTIME_CONTRACT = path.join(repoRoot, 'runtime-contract.json');
    writeOpenClaw(expectedOpenClawVersion);

    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'candidate source revision'], { cwd: source });
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    const candidateEvidence = path.join(openclaw, 'workspace', 'deliverables', 'task-agent-deploy-candidate-result.json');
    fs.writeFileSync(candidateEvidence, JSON.stringify({ source_revision: candidate, result: 'PASS', stage: 'NOOP' }));

    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.checks.provenance.ok, false, JSON.stringify(result));
    assert.equal(result.ok, false, JSON.stringify(result));

    diagnose = await loadDiagnose();
    result = await diagnose({ expectedProductionBaselineSha: candidate });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.provenance.state_production_baseline_sha, baseline);
    assert.equal(result.checks.provenance.production_baseline_sha, candidate);
    assert.equal(result.checks.provenance.candidate_baseline, true);
    assert.equal(result.checks.release.baseline_sha, candidate);
    execFileSync('git', ['reset', '--hard', '-q', baseline], { cwd: source });

    fs.writeFileSync(installedRevision, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n');
    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.checks.provenance.ok, false, JSON.stringify(result));
    fs.writeFileSync(installedRevision, `${controllerRevision}\n`);

    const rolledBackEvidence = path.join(openclaw, 'workspace', 'deliverables', 'task-agent-deploy-newer-result.json');
    fs.writeFileSync(rolledBackEvidence, JSON.stringify({ source_revision: 'cccccccccccccccccccccccccccccccccccccccc', result: 'ROLLED_BACK', stage: 'POST_RESTART' }));
    const newer = new Date(Date.now() + 5000);
    fs.utimesSync(rolledBackEvidence, newer, newer);
    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.provenance.latest_evidence.result, 'ROLLED_BACK');
    assert.equal(result.checks.provenance.baseline_evidence.source_revision, baseline);

    writeOpenClaw('2026.9.0');
    diagnose = await loadDiagnose();
    result = await diagnose();
    assert.equal(result.checks.runtime.ok, false, JSON.stringify(result));
    assert.equal(result.checks.release.ok, false, JSON.stringify(result));
    assert.equal(result.ok, false, JSON.stringify(result));

    const rendered = JSON.stringify(result);
    assert.equal(rendered.includes('TASK-SECRET-CONTENT'), false);
    assert.equal(rendered.includes('CONFIG-SECRET-CONTENT'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of priorEnv.entries()) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
