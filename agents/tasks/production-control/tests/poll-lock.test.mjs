import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const poll = path.join(here, '..', 'poll.sh');

test('poller preserves a live semantic controller lock and performs no controller work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-production-poll-lock-'));
  try {
    fs.writeFileSync(path.join(root, 'controller.lock'), `${process.pid} live-test\n`, { mode: 0o600 });
    const marker = path.join(root, 'controller-ran');
    const fakeController = path.join(root, 'controller');
    fs.writeFileSync(fakeController, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o700 });
    const result = spawnSync('bash', [poll], {
      env: { ...process.env, OPC_STATE_DIR: root, OPC_CONTROLLER: fakeController },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'controller.lock')), true);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
