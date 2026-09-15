# Task Agent independent recovery backup

This directory owns the Task Agent side of Nexus provider-independent recovery. It is separate from deployment rollback.

## Boundary

The runner backs up only the authoritative Task SQLite database. It deliberately does **not** export `openclaw.json`, local deployment recovery sets, plugins, workspaces, sessions, credentials, or other reproducible/runtime state.

A recovery point is:

1. a consistent SQLite snapshot created with `node:sqlite` `backup()` from a read-only connection;
2. validated with `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, and `PRAGMA user_version`;
3. encrypted locally to a dedicated public `age` recipient;
4. uploaded to a private GitLab Generic Package Registry using a project-scoped package-registry write credential;
5. committed by uploading `manifest.json` last.

The manifest contains metadata only. It never contains Task titles, comments, rows, tokens, or raw configuration.

## Credentials

Production configuration is external to the repository:

- `~/.config/nexus-recovery/task-backup.env` — owner-only non-secret binding plus paths;
- `~/.config/nexus-recovery/task-gitlab-token` — owner-only GitLab deploy token with `write_package_registry` only;
- the runner receives only the public `age` recipient.

The private `age` recovery identity must never be installed on the VPS.

See `task-backup.env.example` for the required variables. Do not commit populated configuration or credentials.

## Schedule and status

`task-independent-backup.timer` runs on a four-hour wall-clock schedule and is persistent. The runner writes machine-readable status to:

`~/.local/state/nexus-recovery/task-independent-backup.json`

A successful local status is evidence that the runner created, validated, encrypted, and received successful upload responses for both payload and manifest. Independent provider-side presence and an isolated restore remain separate recovery evidence.

## Installation boundary

Source installation is deterministic but does not create credentials, encryption keys, GitLab projects, or configuration:

```bash
bash ./install.sh --apply
```

The installer requires the external configuration file to exist before enabling the timer. Production activation is a separately governed runtime change.

## Validation

The synthetic test uses a real SQLite database and fake encryption/upload boundaries. It proves consistent snapshot validation, payload-first/manifest-last behavior, token non-disclosure through command arguments, fail-closed foreign-key validation, status semantics, and plaintext staging cleanup without touching production or an external provider.
