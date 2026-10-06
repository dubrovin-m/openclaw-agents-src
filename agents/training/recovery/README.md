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

## Isolated restore qualification

`qualify-restore.sh` is the owner-workstation qualification wrapper around `restore.sh`. It downloads one explicitly selected Training recovery point from the registered GitLab Generic Package Registry, decrypts it only in temporary isolated staging with the externally supplied owner recovery identity, verifies a separately supplied structural fingerprint, removes the plaintext database, and writes owner-only non-sensitive PASS evidence containing only recovery metadata, RPO/RTO observations, integrity result, and cleanup result.

The qualification wrapper requires runtime bindings for `GITLAB_PROJECT_ID`, `GITLAB_DEPLOY_TOKEN_FILE`, and optionally `GITLAB_BASE_URL`, plus absolute paths for the private age identity, expected structural fingerprint, and evidence output. The private identity is never copied into this repository, GitLab, the VPS, or ChatGPT.

## Schedule

The packaged timer follows the existing four-hour Nexus recovery cadence. The actual production schedule is effective only after explicit installation and activation.
