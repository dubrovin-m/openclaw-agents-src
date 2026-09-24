import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksRoot = path.resolve(here, "..");
const repoRoot = path.resolve(tasksRoot, "../..");
const deploy = fs.readFileSync(path.join(tasksRoot, "deploy.sh"), "utf8");
const taskRelease = JSON.parse(fs.readFileSync(path.join(tasksRoot, "release.json"), "utf8"));
const contactsRelease = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "shared/contacts/release.json"), "utf8"),
);

function contactsPredecessorFunction(source) {
  const start = source.indexOf("contacts_predecessor_exact(){");
  const end = source.indexOf("\ncontacts_predecessor_absent(){", start);
  assert.notEqual(start, -1, "contacts_predecessor_exact is missing");
  assert.notEqual(end, -1, "contacts_predecessor_exact boundary is missing");
  return source.slice(start, end);
}

test("Task deploy keeps Task and Shared Contacts predecessor lineages independent", () => {
  assert.match(taskRelease.from?.source_revision ?? "", /^[0-9a-f]{40}$/);
  assert.match(contactsRelease.from?.source_revision ?? "", /^[0-9a-f]{40}$/);
  assert.notEqual(
    taskRelease.from.source_revision,
    contactsRelease.from.source_revision,
    "fixture must exercise independent predecessor lineages",
  );

  const fn = contactsPredecessorFunction(deploy);
  assert.doesNotMatch(
    fn,
    /CONTACTS_FROM_SOURCE[^\n]*RELEASE_FILE/,
    "Contacts predecessor must not be compared with the Task release predecessor revision",
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
