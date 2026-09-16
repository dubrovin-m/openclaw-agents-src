# Task Agent

Private non-secret implementation of the OpenClaw Task Agent.

Canonical purpose, behavior, authority, lifecycle, and expected production state are owned by Nexus. This package owns the reproducible implementation. The live runtime owns actual deployed state and operational Task data.

## Source authority

| Source | Owns |
| --- | --- |
| Nexus | Task Agent purpose, behavior, authority, lifecycle, and expected runtime relationships |
| `taskctl` | Deterministic Task backend and SQLite behavior |
| `plugins/taskctl/` | OpenClaw tool plugin source, build metadata, dependencies, and generated plugin outputs |
| `workspace/` | Runtime instructions for the Task Agent |
| `config/` | Non-secret Task Agent configuration fragments and tool policy |
| `release.json` | Current frozen implementation release and artifact identity |
| Live OpenClaw runtime | Actual installation, provider-managed configuration, credentials, sessions, and deployed state |
| Task SQLite | Operational Task data |
| Git history | Previous implementation and release history |

Do not duplicate volatile runtime or release versions in this README. Read the owning source when an exact version or release identity matters.

## Package layout

- `taskctl` — deterministic JSON CLI used by the Task Agent tools.
- `plugins/taskctl/` — action-specific typed OpenClaw plugin. The generic dispatcher is not model-visible.
- `workspace/` — agent instructions.
- `config/` — non-secret agent and tool-policy fragments.
- `tests/` — deterministic, isolated-runtime, deployment, and recovery regression tests that remain relevant to the current implementation.
- `install.sh` — bounded installation helper with an isolated `--test-root` mode.
- `deploy.sh` — current bounded Task Agent deployment entrypoint.
- `recover.sh` — validation and whole-file restoration of Task Agent recovery sets.

Shared Nexus synchronization and shared media preprocessing are infrastructure-owned under `shared/`; the Task Agent does not own their lifecycle.

## Development and validation

Run:

```bash
./validate.sh
```

The routine GitHub quality gate is `.github/workflows/task-agent-ci.yml`. Tests use disposable state and must not access or mutate production Task data.

Plugin development lives under `plugins/taskctl/`. Build and package commands are defined by that package rather than repeated here. Generated outputs committed as part of the current release must reproduce cleanly under CI.

## Deployment and recovery boundary

An implementation commit or frozen release does not authorize production mutation.

The current production-control path may invoke the implementation-owned deployment entrypoint only within its registered authority and after the applicable user-level production approval. Deployment and recovery logic must fail closed on unexpected state and must not expand Task Agent, Nexus, provider, or host authority.

`install.sh --test-root <absolute-empty-path>` and the isolated runtime tests exist to validate reconstruction without touching production. Production recovery uses a bounded recovery set and whole-file restoration rather than reverse-migration logic.

The current frozen release describes only the supported steady state. When a future Task Agent release needs a bounded predecessor transition, that release may declare a new predecessor fingerprint explicitly; completed predecessor releases are retained in Git history rather than in the active tree.

When an effective predecessor is an exact release/runtime baseline plus a later source-owned workspace-only overlay, `release.json` may declare `from.workspace_source_revision` separately from `from.source_revision`. The predecessor verifier must bind generation and tool-policy identity to the exact baseline source revision, derive the complete workspace fingerprint from the exact workspace source revision, require both revisions on the pre-candidate first-parent history, and require the baseline source to be an ancestor of the workspace source. This provenance field does not authorize arbitrary runtime drift or widen any frozen fingerprint.

The initial clean-history public-source migration is the single exception to Git-history materialization of the already-qualified `0.4.16` predecessor. `public-source-bootstrap.json` pins that exception to the exact `0.4.17` release fingerprint, legacy predecessor revisions, initial public snapshot commit/tree, bootstrap parent, and the exact historical schema-v4/schema-v5 revisions used only by migration regressions. The release-predecessor verifier may use this bridge only while the declared release predecessor is absent from public history; once a release predecessor exists in public history, normal historical predecessor verification is mandatory. Historical private-only migration fixtures may continue to be omitted only after the marker's pinned public snapshot and exact fixture revision are independently verified. Current deterministic Project and Recurrence regressions still run, and the marker must not authorize a current-release predecessor once that predecessor exists in public history.

### Compatibility-sensitive rollout sequencing

Once an exact OpenClaw/runtime or protected-path generation has been frozen for production execution, do not merge a later Task/OpenClaw runtime-affecting or protected-path generation that would supersede it until the current target has completed production deployment, affected end-to-end acceptance, and source/runtime reconciliation. Unrelated repository work may continue only when it does not invalidate the frozen target's eligibility, provenance, or acceptance evidence.

A preparation-owned correction discovered before production execution replaces the frozen target rather than creating an additional deployment hop. The corrected target must receive a new immutable source revision and the affected qualification must be rerun before execution.

## Maintenance

Keep the package proportional to the Task capability:

- keep one current release identity in `release.json`;
- keep plugin dependency and compatibility metadata with the plugin package;
- keep only tests and migration paths that protect a current supported state or recovery boundary;
- do not retain old release archives, transition fixtures, backports, or deployment machinery solely as historical documentation — Git history already preserves them;
- remove temporary compatibility or transition machinery when the current supported upstream/runtime path supersedes it.
