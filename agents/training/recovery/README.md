# Training Agent provider-independent recovery

This directory owns the Training Store recovery path. It is separate from deployment rollback.

## Backup boundary

The production backup runner reads only the authoritative Training SQLite database configured through the external `TRAINING_DB` binding.

A recovery point is:

1. a consistent SQLite snapshot made with `node:sqlite backup()`;
2. validated with SQLite integrity, foreign-key, and schema checks;
3. encrypted locally to a public `age` recipient;
4. uploaded to the private GitLab Generic Package Registry;
5. committed by uploading `manifest.json` last.

The private age identity is never installed on the VPS.

Production credentials and database paths remain external to this public repository.

## Restore boundary

`restore.sh` is intended for an isolated recovery environment, not for scheduled execution on the primary VPS.

It:
- verifies manifest class, size, SHA-256, and expected schema;
- decrypts with a separately supplied private age identity;
- verifies SQLite integrity and foreign keys after decryption;
- refuses to overwrite an existing destination;
- installs the validated database with owner-only permissions.

Provider download and production cut-over remain explicit recovery operations.

## Schedule

The packaged timer follows the existing four-hour Nexus recovery cadence. The actual production schedule is effective only after explicit installation and activation.
