import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksRoot = path.resolve(here, "..");
const deploy = fs.readFileSync(path.join(tasksRoot, "deploy.sh"), "utf8");
const recover = fs.readFileSync(path.join(tasksRoot, "recover.sh"), "utf8");
const verifier = fs.readFileSync(path.join(tasksRoot, "production-control", "verify-release-predecessor.mjs"), "utf8");

function contactsPredecessorFunction(source) {
  const start = source.indexOf("contacts_predecessor_exact(){");
  const end = source.indexOf("\ncontacts_starting_eligible(){", start);
  assert.notEqual(start, -1, "contacts_predecessor_exact is missing");
  assert.notEqual(end, -1, "contacts_predecessor_exact boundary is missing");
  return source.slice(start, end);
}

test("Task deploy binds Shared Contacts to the exact declared predecessor lineage", () => {
  const fn = contactsPredecessorFunction(deploy);
  assert.match(fn, /\[ -n "\$CONTACTS_FROM_SOURCE" \] \|\| return 1/);
  assert.match(fn, /git -C "\$REPO_ROOT" show "\$CONTACTS_FROM_SOURCE:shared\/contacts\/release\.json"/);
  assert.match(fn, /CONTACTS_FROM_RELEASE_SHA/);
  assert.doesNotMatch(fn, /predecessor_absent/);
});

test("Task deploy starting window contains only the exact Contacts predecessor", () => {
  const start = deploy.indexOf("contacts_starting_eligible(){");
  const end = deploy.indexOf("\n\ntaskctl_target_exact(){", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const fn = deploy.slice(start, end);
  assert.match(fn, /contacts_predecessor_exact/);
  assert.doesNotMatch(fn, /contacts_predecessor_absent/);
  assert.doesNotMatch(fn, /contacts_runtime_exact/);
});

test("Task recovery accepts only the current schema 9 physical shape", () => {
  const start = recover.indexOf("recovery_db_schema() {");
  const end = recover.indexOf("\n\nvalidate_recovery_set()", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const fn = recover.slice(start, end);
  assert.match(fn, /uv!==9/);
  assert.match(fn, /physical_current|recurrenceShape/);
  assert.match(fn, /task_domain_bindings/);
  assert.match(fn, /deadline_change_requests/);
  assert.doesNotMatch(fn, /physicalV[4-8]/);
});

test("release predecessor verifier has no public-bootstrap fallback", () => {
  assert.match(verifier, /provenance_mode: 'history'/);
  assert.doesNotMatch(verifier, /public-source-bootstrap/);
  assert.doesNotMatch(verifier, /historical_test_revisions/);
  assert.match(verifier, /predecessor history is unavailable/);
});
