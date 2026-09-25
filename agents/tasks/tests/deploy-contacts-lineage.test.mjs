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

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} is missing`);
  assert.notEqual(end, -1, `${endMarker} boundary is missing`);
  return source.slice(start, end);
}

test("Task deploy validates Shared Contacts against its exact predecessor lineage", () => {
  const fn = section(deploy, "contacts_predecessor_exact(){", "\ncontacts_starting_eligible(){");
  assert.match(fn, /\[ -n "\$CONTACTS_FROM_SOURCE" \] \|\| return 1/);
  assert.match(fn, /git -C "\$REPO_ROOT" show "\$CONTACTS_FROM_SOURCE:shared\/contacts\/release\.json"/);
  assert.match(fn, /CONTACTS_FROM_RELEASE_SHA/);
  assert.doesNotMatch(fn, /predecessor_absent|CONTACTS_PREDECESSOR_MODE/);
});

test("Task deploy supports only the declared current Shared Contacts predecessor", () => {
  const fn = section(deploy, "contacts_starting_eligible(){", "\ntaskctl_target_exact(){");
  assert.match(fn, /contacts_predecessor_exact/);
  assert.doesNotMatch(fn, /contacts_runtime_exact|contacts_predecessor_absent|absent/);
});

test("Task recovery accepts only current schema 9 and current v4 format", () => {
  const db = section(recover, "recovery_db_schema() {", "\n\nvalidate_recovery_set()");
  assert.match(db, /uv!==9/);
  assert.match(db, /task_domain_bindings/);
  assert.match(db, /deadline_change_requests/);
  assert.doesNotMatch(db, /physicalV[4-8]|\[4,5,6,7,8,9\]/);

  assert.match(recover, /CONTACTS_RECOVERY_FORMAT="task-agent-recovery-v4"/);
  assert.doesNotMatch(recover, /task-agent-recovery-v[123]/);
});

test("release predecessor verification uses only normal Git history", () => {
  assert.match(verifier, /provenance_mode: 'history'/);
  assert.match(verifier, /predecessor history is unavailable/);
  assert.doesNotMatch(verifier, /public-source-bootstrap|historical_test_revisions|bootstrapPath|bootstrapRevision/);
});
