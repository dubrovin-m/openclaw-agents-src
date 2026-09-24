import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksRoot = path.resolve(here, "..");
const deploy = fs.readFileSync(path.join(tasksRoot, "deploy.sh"), "utf8");

function contactsPredecessorFunction(source) {
  const start = source.indexOf("contacts_predecessor_exact(){");
  const end = source.indexOf("\ncontacts_predecessor_absent(){", start);
  assert.notEqual(start, -1, "contacts_predecessor_exact is missing");
  assert.notEqual(end, -1, "contacts_predecessor_exact boundary is missing");
  return source.slice(start, end);
}

test("Task deploy validates Shared Contacts against its own predecessor lineage", () => {
  const fn = contactsPredecessorFunction(deploy);

  assert.doesNotMatch(
    fn,
    /CONTACTS_FROM_SOURCE[^\n]*RELEASE_FILE/,
    "Contacts predecessor must not be compared with the Task release predecessor revision",
  );
  assert.match(
    fn,
    /\[ -n "\$CONTACTS_FROM_SOURCE" \] \|\| return 1/,
    "Contacts predecessor source revision must remain required",
  );
  assert.match(
    fn,
    /git -C "\$REPO_ROOT" show "\$CONTACTS_FROM_SOURCE:shared\/contacts\/release\.json"/,
    "Contacts predecessor must remain bound to its own source revision",
  );
  assert.match(
    fn,
    /CONTACTS_FROM_RELEASE_SHA/,
    "Contacts predecessor must remain fingerprint-verified",
  );
});


test("Task deploy accepts Shared Contacts that are already at the target generation", () => {
  const start = deploy.indexOf("contacts_starting_eligible(){");
  const end = deploy.indexOf("\n\ntaskctl_target_exact(){", start);
  assert.notEqual(start, -1, "contacts_starting_eligible is missing");
  assert.notEqual(end, -1, "contacts_starting_eligible boundary is missing");
  const fn = deploy.slice(start, end);

  assert.match(
    fn,
    /contacts_runtime_exact/,
    "already-target Shared Contacts must be an eligible Task deployment starting state",
  );
  assert.match(
    fn,
    /contacts_predecessor_exact/,
    "exact Shared Contacts predecessor validation must remain supported",
  );
  assert.match(
    fn,
    /contacts_predecessor_absent/,
    "absent Shared Contacts predecessor validation must remain supported",
  );
});
