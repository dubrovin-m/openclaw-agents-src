'use strict';

// Test-only synchronization: both independent CLI processes reach BEGIN IMMEDIATE
// before either is permitted to acquire the SQLite writer lock.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const ready = process.env.IDEMPOTENCY_BARRIER_READY;
const release = process.env.IDEMPOTENCY_BARRIER_RELEASE;
if (!ready || !release) throw new Error('Missing idempotency test barrier paths');

const exec = DatabaseSync.prototype.exec;
let intercepted = false;
DatabaseSync.prototype.exec = function (sql) {
  if (!intercepted && /^\s*BEGIN IMMEDIATE\s*;?\s*$/i.test(sql)) {
    intercepted = true;
    fs.writeFileSync(ready, String(process.pid));
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(release)) Atomics.wait(cell, 0, 0, 20);
  }
  return exec.call(this, sql);
};
