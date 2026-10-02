import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pruneSupersededRolloutBackups } from '../lib.mjs';

function createPrivateFile(file, content = 'backup') {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

test('retains the current verified rollout backup and prunes superseded request backups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-recovery-retention-'));
  try {
    const recovery = path.join(root, 'recovery');
    const oldA = path.join(recovery, 'request-101', 'old-a.tar.gz');
    const oldB = path.join(recovery, 'request-102', 'old-b.tar.gz');
    const current = path.join(recovery, 'request-103', 'current.tar.gz');
    const unrelated = path.join(recovery, 'manual', 'manual.tar.gz');
    for (const file of [oldA, oldB, current, unrelated]) createPrivateFile(file);

    const result = pruneSupersededRolloutBackups(recovery, current);

    assert.equal(result.retained, fs.realpathSync(current));
    assert.deepEqual(new Set(result.removed), new Set([oldA, oldB].map((file) => path.resolve(file))));
    assert.equal(fs.existsSync(current), true);
    assert.equal(fs.existsSync(oldA), false);
    assert.equal(fs.existsSync(oldB), false);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validates all rollout backup candidates before deleting any', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-recovery-retention-'));
  try {
    const recovery = path.join(root, 'recovery');
    const old = path.join(recovery, 'request-201', 'old.tar.gz');
    const current = path.join(recovery, 'request-202', 'current.tar.gz');
    const unsafe = path.join(recovery, 'request-203', 'unsafe.tar.gz');
    createPrivateFile(old);
    createPrivateFile(current);
    createPrivateFile(unsafe);
    fs.chmodSync(unsafe, 0o644);

    assert.throws(() => pruneSupersededRolloutBackups(recovery, current), /group\/world accessible/u);
    assert.equal(fs.existsSync(old), true);
    assert.equal(fs.existsSync(current), true);
    assert.equal(fs.existsSync(unsafe), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a current backup outside a numeric rollout request directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-recovery-retention-'));
  try {
    const recovery = path.join(root, 'recovery');
    const current = path.join(recovery, 'manual', 'current.tar.gz');
    createPrivateFile(current);
    assert.throws(() => pruneSupersededRolloutBackups(recovery, current), /outside a rollout request directory/u);
    assert.equal(fs.existsSync(current), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
