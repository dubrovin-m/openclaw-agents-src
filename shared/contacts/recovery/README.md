# Shared Contacts provider-independent recovery

Contacts SQLite is a separate authoritative operational source. This recovery boundary protects only the Contacts SQLite database; it is not a deployment rollback, OpenClaw configuration export, workspace backup, or credential backup.

## Snapshot

The backup runner uses the existing Nexus recovery pattern:

1. Create a consistent SQLite snapshot with `node:sqlite backup()` from a read-only connection.
2. Fail closed unless SQLite integrity, foreign-key and schema checks pass.
3. Encrypt with the configured public `age` recipient before uploading.
4. Upload the encrypted payload to the owner-private GitLab Generic Package Registry, then upload `manifest.json` last as the completion marker.
5. Record machine-readable success/failure and ciphertext hash in `~/.local/state/nexus-recovery/contacts-independent-backup.json`; remove plaintext temporary staging.

The runner reads `CONTACTS_DB` from external runtime configuration, normally `~/.openclaw/data/contacts/contacts.sqlite3`. The other external configuration inputs are `GITLAB_PROJECT_ID`, `GITLAB_DEPLOY_TOKEN_FILE`, `AGE_RECIPIENT`, and optional `GITLAB_BASE_URL`.

Neither secrets nor the private age identity belong in this repository, Nexus, ChatGPT, or the VPS backup payload. The existing authorized VPS GitLab deploy credential and public age recipient may be reused within their approved read/write boundary; never copy private decryption identity onto the VPS.

## Install and schedule

`bash ./install.sh --test-root /absolute/disposable/path --apply` validates the installer in disposable staging. `bash ./install.sh --apply` installs only after the external configuration exists, and enables the user-level `contacts-independent-backup.timer` (four-hour persistent cadence, staggered at minute 10).

Installation and live backup execution are separately governed production actions. They must not silently expand the runtime's authority.

## Restore

`restore.sh` is an **isolated recovery** primitive. It authenticates the payload against its manifest, decrypts using a separately supplied owner-held age identity, rechecks SQLite integrity/foreign keys/schema, refuses to overwrite an existing destination, and installs a validated owner-only file.

Download, owner-controlled decryption, Contacts domain structural validation (Person identity, aliases, Person Groups, Important Dates, reminder policies), representative runtime reconstruction, RPO/RTO measurement, and plaintext cleanup are required to qualify recovery. Do not run the restore on the active Contacts database or copy private recovery identity to the VPS.

## Tests

`bash ./tests/backup.sh` exercises snapshot/manifest integrity, fail-closed foreign-key handling, missing secrets avoidance, plaintext cleanup, isolated restore and tamper rejection with synthetic SQLite fixtures; it also uses the Contacts domain's own schema initialization and structural counts. Tests do not contact GitLab.
