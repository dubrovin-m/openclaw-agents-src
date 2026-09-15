# Task Agent semantic production-control ingress

The existing GitHub control-request channel remains the active and supported deterministic authorization path. This interface adds a second owner-facing ingress for the same bounded production-control authority; it does not add a second deployment engine.

## Registered operations

The OpenClaw `task_production_control` tool may submit only:

- `status` — bounded controller state, no mutation;
- `diagnose` — registered bounded read-only diagnostics, no mutation;
- `deploy <exact-40-character-sha>` — one exact-revision deployment request.

Only agent `main` may invoke this tool. The dedicated `tasks` agent does not receive it in its tool allowlist.

## Approval boundary

`status` and `diagnose` do not require a human approval. `deploy` requires a critical plugin permission request with only `allow-once` or `deny` decisions. The reviewed SHA is part of the frozen tool parameters; approval does not authorize a different revision or arbitrary shell execution.

A denied, timed-out, cancelled, malformed, or unauthorized tool call must not reach the deployment mutation path.

## Execution boundary

The plugin imports the installed production controller module and calls a fixed semantic export. It does not invoke `bash`, `exec`, `systemd-run`, or a user-supplied executable.

The controller continues to own:

- current-`main` exact revision validation;
- merged-PR provenance;
- required CI evidence;
- protected production-control path checks;
- controller lifecycle and deployment-block state;
- shared controller-lock exclusion with the scheduled poller, including fail-closed live-lock handling;
- installed-controller revision equality with the bootstrapped controller revision before semantic deployment;
- exact source checkout preparation;
- detached execution through the existing frozen deployment wrapper;
- rollback, reconciliation, durable result evidence, and commit-status reporting.

Semantic deployment request identifiers are local numeric identifiers and never advance or replace the GitHub control-comment watermark. Existing GitHub requests therefore remain independently consumable and single-use.

## Credential and authority boundary

No new GitHub credential is introduced. The controller credential retains its existing minimum permissions and, in particular, has no Issues write authority. The semantic ingress does not create GitHub issue comments and cannot authorize itself through the GitHub request channel.

Raw OpenClaw host `exec` policy is unchanged. Raw exec remains an exceptional maintenance, investigation, controller-repair, and break-glass path rather than the routine Task Agent production-control interface.

## Activation boundary

Merging this source does not activate the semantic ingress in production. Activation requires a separately approved runtime change that installs the validated controller/plugin generation, exposes `task_production_control` only to `main`, validates the plugin approval route to the owner, and reconciles the resulting runtime state with Nexus.
