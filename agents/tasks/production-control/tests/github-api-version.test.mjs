import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const controllerSource = fs.readFileSync(new URL('../controller.mjs', import.meta.url), 'utf8');

test('pins GitHub REST API version compatible with exact merge provenance', () => {
  assert.match(controllerSource, /const API_VERSION = '2022-11-28';/u);
  assert.match(controllerSource, /'X-GitHub-Api-Version': API_VERSION/u);
  assert.doesNotMatch(controllerSource, /const API_VERSION = '2026-03-10';/u);
});
