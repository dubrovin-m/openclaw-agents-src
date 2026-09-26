#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const taskctlPath = path.join(here, 'taskctl');
const entryPoint = 'agents/tasks/taskctl-src/main.cjs';
const esbuildPackage = path.join(here, 'plugins/taskctl/node_modules/esbuild/package.json');
const esbuildModule = path.join(here, 'plugins/taskctl/node_modules/esbuild/lib/main.js');
const expectedEsbuildVersion = '0.28.2';
const require = createRequire(import.meta.url);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
if (!fs.existsSync(esbuildPackage) || !fs.existsSync(esbuildModule)) {
  fail('Task CLI build requires the locked Task plugin development dependencies; run npm ci in agents/tasks/plugins/taskctl first');
}
const packageIdentity = JSON.parse(fs.readFileSync(esbuildPackage, 'utf8'));
if (packageIdentity.version !== expectedEsbuildVersion) {
  fail(`Task CLI build requires esbuild ${expectedEsbuildVersion}; found ${packageIdentity.version ?? 'unknown'}`);
}
const runtimeContract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'runtime-contract.json'), 'utf8'));
const nodeVersion = String(runtimeContract?.node?.ci_version ?? '');
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
if (!match) fail('runtime-contract.json has no valid node.ci_version');
const target = `node${match[1]}`;
const esbuild = require(esbuildModule);

async function generate() {
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target,
    write: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    banner: { js: '#!/usr/bin/env node' },
  });
  if (!Array.isArray(result.outputFiles) || result.outputFiles.length !== 1) fail('Task CLI build produced an unexpected output set');
  return result.outputFiles[0].text;
}
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === '--check';
if (args.length > 0 && !check) fail('Usage: build-taskctl.mjs [--check]');
const generated = await generate();
if (check) {
  const committed = fs.readFileSync(taskctlPath, 'utf8');
  if (committed !== generated) fail('agents/tasks/taskctl is stale; regenerate it with node agents/tasks/build-taskctl.mjs');
  process.stdout.write('TASKCTL_GENERATED_CURRENT\n');
} else {
  const tmp = `${taskctlPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, generated, { mode: 0o755 });
  fs.renameSync(tmp, taskctlPath);
  fs.chmodSync(taskctlPath, 0o755);
  process.stdout.write('TASKCTL_GENERATED\n');
}
