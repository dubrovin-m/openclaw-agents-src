#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');
const MARKER = path.join(ROOT, 'public-source-bootstrap.json');

const stableJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const objectExists = (spec) => {
  try { execFileSync('git', ['cat-file', '-e', spec], { cwd: REPO, stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch { return false; }
};
const fail = (message) => { throw new Error(message); };

try {
  const field = process.argv[2];
  const expectedRevision = process.argv[3];
  const baseRevision = process.argv[4] || 'HEAD';
  if (typeof field !== 'string' || !field) fail('historical public bootstrap field is required');
  if (!SHA_RE.test(expectedRevision ?? '')) fail('historical public bootstrap revision is invalid');
  if (!fs.existsSync(MARKER)) fail('historical public bootstrap marker is missing');
  const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
  if (marker?.format !== 'task-agent-public-source-bootstrap-v1') fail('public bootstrap marker format is invalid');
  if (marker?.historical_test_revisions?.[field] !== expectedRevision) fail('historical public bootstrap revision mismatch');

  const snapshot = marker?.public_snapshot;
  if (!SHA_RE.test(snapshot?.commit ?? '') || !SHA_RE.test(snapshot?.tree ?? '') || !SHA_RE.test(snapshot?.parent ?? '')) fail('public bootstrap snapshot identity is invalid');
  if (!objectExists(`${snapshot.commit}^{commit}`) || !objectExists(`${snapshot.parent}^{commit}`)) fail('public bootstrap snapshot object is unavailable');
  if (git(['rev-parse', `${snapshot.commit}^{tree}`]) !== snapshot.tree) fail('public bootstrap snapshot tree mismatch');
  const parents = git(['show', '-s', '--format=%P', snapshot.commit]).split(/\s+/u).filter(Boolean);
  if (parents.length !== 1 || parents[0] !== snapshot.parent) fail('public bootstrap snapshot ancestry mismatch');
  const base = SHA_RE.test(baseRevision) && !/^0{40}$/u.test(baseRevision) ? baseRevision : 'HEAD';
  if (!objectExists(`${base}^{commit}`)) fail('historical public bootstrap base revision is unavailable');
  try { git(['merge-base', '--is-ancestor', snapshot.commit, base]); }
  catch { fail('public bootstrap snapshot is not an ancestor of the historical-test base'); }

  const snapshotRelease = JSON.parse(git(['show', `${snapshot.commit}:agents/tasks/release.json`]));
  const target = marker?.target;
  if (target?.plugin_version !== snapshotRelease?.plugin?.version || target?.taskctl_version !== snapshotRelease?.generation?.taskctl_version || target?.sqlite_schema !== snapshotRelease?.generation?.sqlite_schema) fail('public bootstrap snapshot release identity mismatch');
  if (!SHA256_RE.test(target?.release_sha256 ?? '') || target.release_sha256 !== sha256(stableJson(snapshotRelease))) fail('public bootstrap snapshot release fingerprint mismatch');

  process.stdout.write(`${JSON.stringify({ ok: true, field, revision: expectedRevision, public_snapshot: snapshot.commit })}\n`);
} catch (error) {
  process.stderr.write(`public-historical-fixture: ${error.message}\n`);
  process.exitCode = 2;
}
