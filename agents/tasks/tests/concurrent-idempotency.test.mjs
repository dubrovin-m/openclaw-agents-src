import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const taskctl = path.join(root, 'agents/tasks/taskctl');
const contactctl = path.join(root, 'shared/contacts/contactctl');
const barrier = path.join(root, 'agents/tasks/tests/helpers/begin-barrier.cjs');
const contacts = require(path.join(root, 'shared/contacts/core.cjs'));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-key-race-'));
  const tasksDb = path.join(dir, 'tasks.sqlite3');
  const contactsDb = path.join(dir, 'contacts.sqlite3');
  const env = {
    ...process.env,
    TASKCTL_ALLOW_DB_OVERRIDE: '1',
    TASKCTL_DB: tasksDb,
    TASKCTL_CONTACTS_DB: contactsDb,
    CONTACTCTL_ALLOW_DB_OVERRIDE: '1',
    CONTACTCTL_DB: contactsDb,
  };
  function run(cli, args, payload) {
    const child = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...env, ...(payload ? { [cli === taskctl ? 'TASKCTL_PAYLOAD' : 'CONTACTCTL_PAYLOAD']: JSON.stringify(payload) } : {}) },
      timeout: 10000,
    });
    assert.equal(child.status, 0, `${args.join(' ')}: ${child.stderr} ${child.stdout}`);
    return JSON.parse(child.stdout);
  }
  run(contactctl, ['init']);
  run(taskctl, ['init']);
  return { dir, tasksDb, contactsDb, env, run, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function startContender(f, cli, args, payload, name) {
  const ready = path.join(f.dir, `${name}.ready`);
  const release = path.join(f.dir, `${name}.release`);
  const child = spawn(process.execPath, [cli, ...args], {
    env: {
      ...f.env,
      [cli === taskctl ? 'TASKCTL_PAYLOAD' : 'CONTACTCTL_PAYLOAD']: JSON.stringify(payload),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${barrier}`.trim(),
      IDEMPOTENCY_BARRIER_READY: ready,
      IDEMPOTENCY_BARRIER_RELEASE: release,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, ready, release, done };
}

async function awaitReady(contender) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(contender.ready)) {
    if (contender.child.exitCode !== null) throw new Error(`Contender exited before BEGIN: ${contender.child.exitCode}`);
    if (Date.now() > deadline) throw new Error('Timed out waiting for contender at BEGIN IMMEDIATE');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function contend(f, cli, firstArgs, firstPayload, secondArgs, secondPayload) {
  const a = startContender(f, cli, firstArgs, firstPayload, 'first');
  const b = startContender(f, cli, secondArgs, secondPayload, 'second');
  try {
    // At this point the old implementation has already read an absent receipt
    // on BOTH connections. The fixed implementation has not read either receipt.
    await Promise.all([awaitReady(a), awaitReady(b)]);
    fs.writeFileSync(a.release, '');
    const first = await a.done;
    fs.writeFileSync(b.release, '');
    const second = await b.done;
    return { first, second };
  } finally {
    fs.writeFileSync(a.release, '');
    fs.writeFileSync(b.release, '');
  }
}

function result(output, expectedStatus = 0) {
  assert.equal(output.code, expectedStatus, `unexpected CLI status: ${JSON.stringify(output)}`);
  return JSON.parse(output.stdout);
}

function count(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).get().n; }
  finally { db.close(); }
}

test('Tasks: two independent writers replay one mutation and one receipt', { timeout: 20000 }, async () => {
  const f = fixture();
  try {
    const payload = { operation_key: 'tasks-same', display_name: 'Single Label' };
    const { first, second } = await contend(f, taskctl, ['label', 'create'], payload, ['label', 'create'], payload);
    const original = result(first), replay = result(second);
    assert.equal(original.ok, true);
    assert.equal(original.idempotent_replay, undefined);
    assert.deepEqual(replay, { ...original, idempotent_replay: true });
    assert.equal(count(f.tasksDb, "SELECT count(*) n FROM labels WHERE display_name='Single Label'"), 1);
    assert.equal(count(f.tasksDb, "SELECT count(*) n FROM operation_results WHERE operation_key='tasks-same'"), 1);
    assert.equal(f.run(taskctl, ['label', 'create'], payload).idempotent_replay, true);
  } finally { f.close(); }
});

test('Contacts: two independent writers replay one mutation and one receipt', { timeout: 20000 }, async () => {
  const f = fixture();
  try {
    const payload = { operation_key: 'contacts-same', display_name: 'Single Person' };
    const { first, second } = await contend(f, contactctl, ['create'], payload, ['create'], payload);
    const original = result(first), replay = result(second);
    assert.equal(original.ok, true);
    assert.equal(original.idempotent_replay, undefined);
    assert.deepEqual(replay, { ...original, idempotent_replay: true });
    assert.equal(count(f.contactsDb, "SELECT count(*) n FROM people WHERE display_name='Single Person'"), 1);
    assert.equal(count(f.contactsDb, "SELECT count(*) n FROM operation_results WHERE operation_key='contacts-same'"), 1);
    assert.equal(f.run(contactctl, ['create'], payload).idempotent_replay, true);
    // Tasks continues reading identity from the canonical Shared Contacts database.
    assert.equal(f.run(taskctl, ['person', 'resolve'], { reference: 'Single Person' }).outcome, 'MATCH');
  } finally { f.close(); }
});

for (const mode of ['payload', 'type']) {
  test(`Tasks: concurrent operation_key ${mode} conflict rolls back cleanly`, { timeout: 20000 }, async () => {
    const f = fixture();
    try {
      const first = { operation_key: 'tasks-conflict', display_name: 'Original' };
      const second = mode === 'payload'
        ? { operation_key: first.operation_key, display_name: 'Different' }
        : { operation_key: first.operation_key, alias: 'Alias', expansion: 'Meaning' };
      const { first: a, second: b } = await contend(f, taskctl, ['label', 'create'], first,
        mode === 'payload' ? ['label', 'create'] : ['term', 'set'], second);
      result(a);
      const conflict = result(b, 2);
      assert.equal(conflict.error.code, 'IDEMPOTENCY_KEY_REUSE');
      assert.equal(count(f.tasksDb, "SELECT count(*) n FROM operation_results WHERE operation_key='tasks-conflict'"), 1);
      assert.equal(count(f.tasksDb, 'SELECT count(*) n FROM labels'), 1);
      assert.equal(count(f.tasksDb, 'SELECT count(*) n FROM term_aliases'), 0);
      assert.equal(f.run(taskctl, ['label', 'create'], first).idempotent_replay, true);
      f.run(taskctl, ['label', 'create'], { operation_key: 'tasks-after-conflict', display_name: 'Later' });
    } finally { f.close(); }
  });

  test(`Contacts: concurrent operation_key ${mode} conflict rolls back cleanly`, { timeout: 20000 }, async () => {
    const f = fixture();
    try {
      const first = { operation_key: 'contacts-conflict', display_name: 'Original' };
      const second = { operation_key: first.operation_key, display_name: 'Different' };
      const { first: a, second: b } = await contend(f, contactctl, ['create'], first,
        mode === 'payload' ? ['create'] : ['group_create'], second);
      result(a);
      const conflict = result(b, 2);
      assert.match(conflict.error.message, /operation_key was already used for a different request/);
      assert.equal(count(f.contactsDb, "SELECT count(*) n FROM operation_results WHERE operation_key='contacts-conflict'"), 1);
      assert.equal(count(f.contactsDb, "SELECT count(*) n FROM people WHERE display_name='Original'"), 1);
      assert.equal(count(f.contactsDb, "SELECT count(*) n FROM people WHERE display_name='Different'"), 0);
      assert.equal(count(f.contactsDb, 'SELECT count(*) n FROM person_groups'), 0);
      assert.equal(f.run(contactctl, ['create'], first).idempotent_replay, true);
      f.run(contactctl, ['create'], { operation_key: 'contacts-after-conflict', display_name: 'Later' });
    } finally { f.close(); }
  });
}

test('Tasks callback failure rolls back both attached databases and no receipt survives', () => {
  const f = fixture();
  try {
    const payload = { operation_key: 'tasks-failed', title: 'Rolled-back Task', assignee: 'Transient Person',
      create_assignee: true, labels: ['Missing label'] };
    const failed = spawnSync(process.execPath, [taskctl, 'task', 'create'], {
      encoding: 'utf8', env: { ...f.env, TASKCTL_PAYLOAD: JSON.stringify(payload) },
    });
    assert.notEqual(failed.status, 0);
    assert.equal(count(f.tasksDb, "SELECT count(*) n FROM operation_results WHERE operation_key='tasks-failed'"), 0);
    assert.equal(count(f.tasksDb, "SELECT count(*) n FROM tasks WHERE title='Rolled-back Task'"), 0);
    assert.equal(count(f.contactsDb, "SELECT count(*) n FROM people WHERE display_name='Transient Person'"), 0);
    f.run(taskctl, ['label', 'create'], { operation_key: 'tasks-after-error', display_name: 'Recovered' });
    assert.equal(count(f.tasksDb, 'SELECT count(*) n FROM labels'), 1);
  } finally { f.close(); }
});

test('Contacts callback failure rolls back receipt and effects on the same reusable connection', () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.contactsDb, { timeout: 5000 });
    try {
      db.exec('CREATE TABLE rollback_probe(value TEXT)');
      assert.throws(() => contacts.mutate(db, 'probe.create', { operation_key: 'contacts-failed' }, () => {
        db.prepare('INSERT INTO rollback_probe(value) VALUES(?)').run('uncommitted');
        throw new Error('synthetic callback failure');
      }), /synthetic callback failure/);
      assert.equal(db.prepare('SELECT count(*) n FROM rollback_probe').get().n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM operation_results WHERE operation_key='contacts-failed'").get().n, 0);
      const payload = { operation_key: 'contacts-after-error' };
      const original = contacts.mutate(db, 'probe.create', payload, () => {
        db.prepare('INSERT INTO rollback_probe(value) VALUES(?)').run('committed');
        return { ok: true };
      });
      assert.deepEqual(original, { ok: true });
      assert.deepEqual(contacts.mutate(db, 'probe.create', payload, () => { throw new Error('re-executed'); }),
        { ok: true, idempotent_replay: true });
      assert.throws(() => contacts.mutate(db, 'probe.other', payload, () => ({})),
        /operation_key was already used for a different request/);
      assert.equal(db.prepare('SELECT count(*) n FROM rollback_probe').get().n, 1);
    } finally { db.close(); }
  } finally { f.close(); }
});
