import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pcRoot = path.resolve(here, '..');
const repoRoot = execFileSync('git', ['-C', pcRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const runner = path.join(pcRoot, 'reconcile-baseline-break-glass.sh');
const runnerRevision = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const nodeDir = path.dirname(process.execPath);
const implementationRepository = 'example/source';
const implementationUrl = `https://github.com/${implementationRepository}.git`;
const binding = {
  control_repository: 'example/control',
  implementation_repository: implementationRepository,
  control_issue: 7,
  owner_login: 'owner',
  owner_id: 123,
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeExecutable(file, text) {
  fs.writeFileSync(file, text, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('baseline-only break-glass reconciliation preserves controller revision and has bounded terminal states', () => {
  execFileSync('bash', ['-n', runner]);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-baseline-reconcile.'));
  try {
    const targetRepo = path.join(tmp, 'target-repo');
    const targetTasks = path.join(targetRepo, 'agents', 'tasks');
    fs.mkdirSync(targetTasks, { recursive: true });

    writeExecutable(path.join(targetTasks, 'deploy.sh'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--test-root" ]; then shift 2; fi
[ "\${1:-}" = "--preflight" ] || exit 2
if [ "\${PREFLIGHT_TARGET:-1}" = "1" ]; then
  echo 'TASK_AGENT_DEPLOY_PREFLIGHT_PASS start_is_target=1 target_taskctl=0.4.5 current_taskctl=0.4.5 target_plugin=0.4.17 current_plugin=0.4.17'
else
  echo 'TASK_AGENT_DEPLOY_PREFLIGHT_PASS start_is_target=0 target_taskctl=0.4.5 current_taskctl=0.4.5 target_plugin=0.4.17 current_plugin=0.4.17'
fi
`);
    writeExecutable(path.join(targetTasks, 'recover.sh'), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--test-root" ]; then shift 2; fi
[ "\${1:-}" = "--inspect" ] || exit 2
[ "\${2:-}" = "--from" ] || exit 2
[ -f "\${3:-}/VALID" ] || exit 2
exit 3
`);
    fs.writeFileSync(path.join(targetTasks, 'release.json'), '{"format":"test"}\n');
    fs.writeFileSync(path.join(targetRepo, 'marker.txt'), 'from\n');

    git(targetRepo, ['init', '-q']);
    git(targetRepo, ['config', 'user.email', 'test@example.com']);
    git(targetRepo, ['config', 'user.name', 'test']);
    git(targetRepo, ['remote', 'add', 'origin', implementationUrl]);
    git(targetRepo, ['add', '.']);
    git(targetRepo, ['commit', '-qm', 'from baseline']);
    const fromBaseline = git(targetRepo, ['rev-parse', 'HEAD']);
    const controllerRevision = fromBaseline;

    fs.writeFileSync(path.join(targetRepo, 'marker.txt'), 'to\n');
    git(targetRepo, ['add', 'marker.txt']);
    git(targetRepo, ['commit', '-qm', 'target baseline']);
    const toBaseline = git(targetRepo, ['rev-parse', 'HEAD']);

    const runtime = path.join(tmp, 'runtime');
    const stateDir = path.join(runtime, 'state');
    const libDir = path.join(runtime, 'lib');
    const systemdDir = path.join(runtime, 'systemd');
    const sourceDir = path.join(runtime, 'source');
    const deliverables = path.join(tmp, 'deliverables');
    const recovery = path.join(tmp, 'recovery');
    const shimDir = path.join(tmp, 'shims');
    const systemctlState = path.join(tmp, 'systemctl-state');
    fs.mkdirSync(deliverables, { recursive: true });
    fs.mkdirSync(recovery, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(systemctlState, { recursive: true });
    fs.writeFileSync(path.join(recovery, 'VALID'), 'ok\n');

    writeExecutable(path.join(shimDir, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
state=\${TEST_SYSTEMCTL_STATE:?}
[ "\${1:-}" = "--user" ] && shift
case "\${1:-}" in
  start)
    [ "\${2:-}" = "openclaw-task-production-control.timer" ] || exit 2
    [ ! -f "\$state/fail-start" ] || exit 1
    echo active > "\$state/timer"
    ;;
  stop)
    [ "\${2:-}" = "openclaw-task-production-control.timer" ] || exit 2
    echo inactive > "\$state/timer"
    ;;
  is-active)
    if [ "\${2:-}" = "--quiet" ]; then unit=\${3:-}; else unit=\${2:-}; fi
    case "\$unit" in
      openclaw-task-production-control.timer) [ "\$(cat "\$state/timer")" = active ] ;;
      openclaw-task-production-control.service) [ "\$(cat "\$state/service")" = active ] ;;
      nexus-sync.timer) [ "\$(cat "\$state/nexus")" = active ] ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`);

    const controller = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
if(process.argv[2]!=='diagnose-local') process.exit(2);
let ok=false;
try {
  const stateDir=process.env.OPC_STATE_DIR;
  const libDir=process.env.OPC_LIB_DIR;
  const runtimeRoot=path.dirname(stateDir);
  const candidate=process.env.OPC_CONTROLLER_STATE;
  const statePath=candidate||path.join(stateDir,'state.json');
  const sourceDir=process.env.OPC_SOURCE_DIR||path.join(runtimeRoot,'source');
  if(process.env.FAIL_CANDIDATE_DIAG==='1'&&candidate) throw new Error('candidate fail');
  if(process.env.FAIL_FINAL_DIAG==='1'&&!candidate) throw new Error('final fail');
  const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
  const installed=fs.readFileSync(path.join(libDir,'installed-revision'),'utf8').trim();
  const source=execFileSync('git',['-C',sourceDir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  ok=state.controller_revision===installed&&state.production_baseline_sha===source;
} catch {}
process.stdout.write(JSON.stringify({ok})+'\\n');
`;

    function writeDeployResult(stage = 'NOOP', source = toBaseline, recoverySet = null) {
      const result = {
        result: 'PASS',
        stage,
        source_revision: source,
        mutation_started: stage === 'COMPLETE',
        recovery_set: recoverySet,
      };
      const file = path.join(deliverables, 'task-result.json');
      fs.writeFileSync(file, `${JSON.stringify(result)}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return file;
    }

    function resetRuntime() {
      fs.rmSync(runtime, { recursive: true, force: true });
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(libDir, { recursive: true });
      fs.mkdirSync(systemdDir, { recursive: true });
      fs.writeFileSync(path.join(libDir, 'installed-revision'), `${controllerRevision}\n`, { mode: 0o600 });
      fs.writeFileSync(path.join(libDir, 'controller.mjs'), controller, { mode: 0o700 });
      fs.chmodSync(path.join(libDir, 'controller.mjs'), 0o700);
      fs.writeFileSync(path.join(systemdDir, 'openclaw-task-production-control.timer'), '[Timer]\n', { mode: 0o644 });
      fs.writeFileSync(path.join(systemdDir, 'openclaw-task-production-control.service'), '[Service]\n', { mode: 0o644 });
      const state = {
        version: 1,
        ...binding,
        mode: 'ACTIVE',
        controller_revision: controllerRevision,
        production_baseline_sha: fromBaseline,
        deployment_blocked: false,
        last_diagnostic: { ok: true },
        requests: { 77: { type: 'diagnose', state: 'SUCCESS', completed_at: 'old' } },
        watermark: 100,
        minimum_comment_id: 50,
      };
      fs.writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify(state)}\n`, { mode: 0o600 });
      git(tmp, ['clone', '-q', '--no-hardlinks', '--no-checkout', targetRepo, sourceDir]);
      git(sourceDir, ['checkout', '-q', '--detach', fromBaseline]);
      git(sourceDir, ['remote', 'set-url', 'origin', implementationUrl]);
      fs.writeFileSync(path.join(systemctlState, 'timer'), 'inactive\n');
      fs.writeFileSync(path.join(systemctlState, 'service'), 'inactive\n');
      fs.writeFileSync(path.join(systemctlState, 'nexus'), 'active\n');
      fs.rmSync(path.join(systemctlState, 'fail-start'), { force: true });
    }

    const baseEnv = {
      ...process.env,
      HOME: path.join(tmp, 'home'),
      PATH: `${shimDir}:${nodeDir}:/usr/bin:/bin`,
      TEST_SYSTEMCTL_STATE: systemctlState,
      OPC_IMPLEMENTATION_REPOSITORY: implementationRepository,
    };
    fs.mkdirSync(path.join(baseEnv.HOME, '.npm-global', 'bin'), { recursive: true });

    function run(extraEnv = {}, overrides = {}) {
      const deployResult = overrides.deployResult ?? path.join(deliverables, 'task-result.json');
      const targetSource = overrides.targetSource ?? targetRepo;
      const args = [
        runner,
        '--test-root', runtime,
        '--runner', overrides.runnerRevision ?? runnerRevision,
        '--controller', overrides.controllerRevision ?? controllerRevision,
        '--from-baseline', overrides.fromBaseline ?? fromBaseline,
        '--to-baseline', overrides.toBaseline ?? toBaseline,
        '--target-source', targetSource,
        '--deploy-result', deployResult,
        '--apply',
      ];
      return spawnSync('bash', args, { env: { ...baseEnv, ...extraEnv }, encoding: 'utf8' });
    }

    function assertOldState() {
      assert.equal(fs.readFileSync(path.join(libDir, 'installed-revision'), 'utf8').trim(), controllerRevision);
      const state = readJson(path.join(stateDir, 'state.json'));
      assert.equal(state.controller_revision, controllerRevision);
      assert.equal(state.production_baseline_sha, fromBaseline);
      assert.equal(state.implementation_repository, implementationRepository);
      assert.equal(state.watermark, 100);
      assert.equal(state.minimum_comment_id, 50);
      assert.equal(state.requests['77'].state, 'SUCCESS');
      assert.deepEqual(state.last_diagnostic, { ok: true });
      assert.equal(git(sourceDir, ['rev-parse', 'HEAD']), fromBaseline);
      assert.equal(fs.readFileSync(path.join(systemctlState, 'timer'), 'utf8').trim(), 'inactive');
    }

    function assertTargetState(stage) {
      assert.equal(fs.readFileSync(path.join(libDir, 'installed-revision'), 'utf8').trim(), controllerRevision);
      const state = readJson(path.join(stateDir, 'state.json'));
      assert.equal(state.controller_revision, controllerRevision);
      assert.equal(state.production_baseline_sha, toBaseline);
      assert.equal(state.implementation_repository, implementationRepository);
      assert.equal(state.last_diagnostic, null);
      assert.equal(state.watermark, 100);
      assert.equal(state.minimum_comment_id, 50);
      assert.equal(state.requests['77'].state, 'SUCCESS');
      assert.equal(state.last_break_glass_reconciliation.mode, 'baseline-only');
      assert.equal(state.last_break_glass_reconciliation.controller_revision, controllerRevision);
      assert.equal(state.last_break_glass_reconciliation.from_production_baseline, fromBaseline);
      assert.equal(state.last_break_glass_reconciliation.to_production_baseline, toBaseline);
      assert.equal(state.last_break_glass_reconciliation.deploy_stage, stage);
      assert.equal(state.last_break_glass_reconciliation.runner_revision, runnerRevision);
      assert.equal(git(sourceDir, ['rev-parse', 'HEAD']), toBaseline);
      assert.equal(git(sourceDir, ['remote', 'get-url', 'origin']), implementationUrl);
      assert.equal(fs.readFileSync(path.join(systemctlState, 'timer'), 'utf8').trim(), 'active');
      const results = fs.readdirSync(stateDir)
        .filter((name) => name.startsWith('baseline-break-glass-reconcile-'))
        .map((name) => path.join(stateDir, name, 'result.json'))
        .filter((file) => fs.existsSync(file));
      assert.ok(results.length >= 1);
      const result = readJson(results.at(-1));
      assert.equal(result.result, 'PASS');
      assert.equal(result.mode, 'baseline-only');
      assert.equal(result.controller_revision, controllerRevision);
      assert.equal(result.to_production_baseline, toBaseline);
    }

    resetRuntime();
    writeDeployResult('NOOP', toBaseline, null);
    let result = run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /TASK_PRODUCTION_BASELINE_BREAK_GLASS_RECONCILIATION_PASS/);
    assertTargetState('NOOP');

    resetRuntime();
    writeDeployResult('COMPLETE', toBaseline, recovery);
    result = run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assertTargetState('COMPLETE');

    resetRuntime();
    writeDeployResult('NOOP', fromBaseline, null);
    result = run();
    assert.equal(result.status, 2);
    assertOldState();

    resetRuntime();
    const invalidRecovery = path.join(tmp, 'invalid-recovery');
    fs.mkdirSync(invalidRecovery, { recursive: true });
    writeDeployResult('COMPLETE', toBaseline, invalidRecovery);
    result = run();
    assert.equal(result.status, 2);
    assertOldState();

    resetRuntime();
    writeDeployResult('NOOP', toBaseline, null);
    result = run({ PREFLIGHT_TARGET: '0' });
    assert.equal(result.status, 2);
    assertOldState();

    resetRuntime();
    writeDeployResult('NOOP', toBaseline, null);
    fs.writeFileSync(path.join(systemctlState, 'timer'), 'active\n');
    result = run();
    assert.equal(result.status, 2);
    fs.writeFileSync(path.join(systemctlState, 'timer'), 'inactive\n');
    assertOldState();

    resetRuntime();
    writeDeployResult('NOOP', toBaseline, null);
    result = run({ FAIL_CANDIDATE_DIAG: '1' });
    assert.notEqual(result.status, 0);
    assertOldState();

    resetRuntime();
    writeDeployResult('NOOP', toBaseline, null);
    result = run({ FAIL_FINAL_DIAG: '1' });
    assert.notEqual(result.status, 0);
    assertOldState();

    resetRuntime();
    writeDeployResult('NOOP', toBaseline, null);
    fs.writeFileSync(path.join(systemctlState, 'fail-start'), '1\n');
    result = run();
    assert.notEqual(result.status, 0);
    fs.rmSync(path.join(systemctlState, 'fail-start'), { force: true });
    assertOldState();

    resetRuntime();
    writeDeployResult('NOOP', toBaseline, null);
    result = run({}, { runnerRevision: '0'.repeat(40) });
    assert.equal(result.status, 2);
    assertOldState();

    resetRuntime();
    writeDeployResult('NOOP', toBaseline, null);
    fs.writeFileSync(path.join(targetRepo, 'dirty.txt'), 'dirty\n');
    result = run();
    assert.equal(result.status, 2);
    fs.rmSync(path.join(targetRepo, 'dirty.txt'));
    assertOldState();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
