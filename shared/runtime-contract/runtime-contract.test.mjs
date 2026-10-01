import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRepositoryMetadataConsistency,
  isSupportedNodeVersion,
  loadOpenClawQualification,
  loadRuntimeContract,
  validateContract,
  validateOpenClawQualification,
} from './runtime-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const contract = loadRuntimeContract(path.join(repoRoot, 'runtime-contract.json'));
const qualification = loadOpenClawQualification(path.join(repoRoot, 'openclaw-qualification.json'));

test('runtime contract contains runtime requirements without an OpenClaw host pin', () => {
  assert.equal(contract.format, 'openclaw-agents-runtime-contract-v2');
  assert.equal(Object.hasOwn(contract, 'openclaw'), false);
  assert.equal(contract.node.ci_version, '26.7.0');
});

test('OpenClaw qualification target is explicit and separate from runtime requirements', () => {
  assert.equal(qualification.format, 'openclaw-qualification-target-v1');
  assert.match(qualification.version, /^\d+\.\d+\.\d+$/u);
});

test('Task and Contacts release metadata stays internally consistent without a host equality gate', () => {
  const result = assertRepositoryMetadataConsistency(repoRoot, contract);
  assert.equal(result.ok, true);
  assert.equal(result.node_ci_version, '26.7.0');
  assert.equal(result.openclaw_build_version, qualification.version);
  assert.equal(result.contacts_openclaw_build_version, qualification.version);
  assert.equal(result.openclaw_compat, result.contacts_openclaw_compat);
  assert.equal(typeof result.openclaw_compat, 'string');
  assert.notEqual(result.openclaw_compat.trim(), '');
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

test('malformed or internally inconsistent runtime requirements fail closed', () => {
  assert.throws(() => validateContract({}), /unsupported runtime contract format/u);
  assert.throws(() => validateContract({
    format: 'openclaw-agents-runtime-contract-v2',
    openclaw: { version: '2026.9.5' },
    node: {
      ci_version: '24.15.0',
      supported_lines: [{ major: 24, minimum: '24.15.0' }],
      required_builtin_modules: ['node:sqlite'],
    },
  }), /belongs in qualification state/u);
  assert.throws(() => validateContract({
    format: 'openclaw-agents-runtime-contract-v2',
    node: {
      ci_version: '23.0.0',
      supported_lines: [{ major: 24, minimum: '24.15.0' }],
      required_builtin_modules: ['node:sqlite'],
    },
  }), /ci_version is outside/u);
});

test('malformed OpenClaw qualification targets fail closed', () => {
  assert.throws(() => validateOpenClawQualification({}), /unsupported OpenClaw qualification target format/u);
  assert.throws(() => validateOpenClawQualification({
    format: 'openclaw-qualification-target-v1',
    version: 'latest',
  }), /invalid semantic version/u);
});
