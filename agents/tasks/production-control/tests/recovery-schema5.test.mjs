import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..', '..');
const script = path.join(repoRoot, 'agents/tasks/tests/recovery-schema5.sh');
const release = JSON.parse(fs.readFileSync(path.join(repoRoot, 'agents/tasks/release.json'), 'utf8'));
const schema5Predecessor = Array.isArray(release?.from?.sqlite_schemas) && release.from.sqlite_schemas.includes(5);

test('schema-5 predecessor recovery survives post-mutation rollback', {
  skip: schema5Predecessor ? false : 'current release does not admit a schema-5 predecessor',
}, () => {
  const result = spawnSync('bash', [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });

  assert.equal(
    result.status,
    0,
    `schema-5 recovery regression failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /TASK_AGENT_SCHEMA5_RECOVERY_ROLLBACK_PASS/);
});
