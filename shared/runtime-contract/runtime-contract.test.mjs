import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRepositoryCompatibility,
  isOpenClawVersionCompatible,
  isSupportedNodeVersion,
  loadRuntimeContract,
  validateContract,
} from './runtime-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const contract = loadRuntimeContract(path.join(repoRoot, 'runtime-contract.json'));

test('Task and Contacts plugin releases match the qualified runtime contract exactly', () => {
  const result = assertRepositoryCompatibility(repoRoot, contract);
  assert.equal(result.ok, true);
  assert.equal(result.openclaw_version, contract.openclaw.version);
  assert.equal(result.node_ci_version, '26.7.0');
  assert.equal(result.openclaw_build_version, '2026.9.5');
  assert.equal(result.openclaw_compat, '2026.9.5');
  assert.equal(result.contacts_openclaw_build_version, '2026.9.5');
  assert.equal(result.contacts_openclaw_compat, '2026.9.5');
});

test('plugin compatibility does not imply unqualified future OpenClaw hosts', () => {
  assert.equal(isOpenClawVersionCompatible('2026.9.5', '2026.9.5'), true);
  assert.equal(isOpenClawVersionCompatible('2026.9.6', '2026.9.5'), false);
  assert.equal(isOpenClawVersionCompatible('2026.9.4', '2026.9.5'), false);
  assert.equal(isOpenClawVersionCompatible('2026.9.5', '>=2026.9.5'), false);
});

test('supported Node lines are explicit and bounded', () => {
  assert.equal(isSupportedNodeVersion('22.22.3', contract), true);
  assert.equal(isSupportedNodeVersion('22.22.2', contract), false);
  assert.equal(isSupportedNodeVersion('23.99.99', contract), false);
  assert.equal(isSupportedNodeVersion('24.15.0', contract), true);
  assert.equal(isSupportedNodeVersion('24.14.9', contract), false);
  assert.equal(isSupportedNodeVersion('25.9.0', contract), true);
  assert.equal(isSupportedNodeVersion('25.8.9', contract), false);
  assert.equal(isSupportedNodeVersion('26.0.0', contract), true);
  assert.equal(isSupportedNodeVersion('27.0.0', contract), false);
});

test('malformed or internally inconsistent contracts fail closed', () => {
  assert.throws(() => validateContract({}), /unsupported runtime contract format/u);
  assert.throws(() => validateContract({
    format: 'openclaw-agents-runtime-contract-v1',
    openclaw: { version: '2026.8.1' },
    node: {
      ci_version: '23.0.0',
      supported_lines: [{ major: 24, minimum: '24.15.0' }],
      required_builtin_modules: ['node:sqlite'],
    },
  }), /ci_version is outside/u);
});
