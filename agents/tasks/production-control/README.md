# Task Agent production control

Deterministic production-control implementation for the Task Agent.

This directory owns reusable controller mechanics only. It does not own or publish a live production authorization endpoint, owner identity, private control repository, control issue number, production baseline, credentials, or execution evidence.

## Authority split

The controller intentionally separates three authorities:

- a private owner-authorized control source supplies bounded production requests;
- a distinct implementation repository supplies exact source revisions, Pull Request provenance, and required CI evidence;
- owner-private runtime state retains production execution and diagnostic evidence.

The control and implementation repositories must be distinct. Their concrete identities are supplied only during an explicitly approved bootstrap and are then persisted in owner-private controller state. Public repository content, Pull Requests, workflow input, fork content, and public Issues are never production authorization.

## Request grammar

The deterministic parser accepts only the bounded operations implemented in `lib.mjs`. It never interprets free-form shell commands. Authorization additionally requires the exact configured owner identity, an unedited post-bootstrap request, and the private control source recorded in controller state.

## Implementation provenance

A deployment or rollout target must be an exact current `main` revision in the configured implementation repository, have the required merged-Pull-Request provenance, and have the required successful CI evidence. Protected controller/deployment paths remain fail-closed and require a separately prepared controller or break-glass change.

The implementation checkout used for execution is prepared from that implementation repository only. The private control repository is not implementation authority.

## Private evidence boundary

Production diagnostics, request outcomes, recovery evidence, baselines, and detailed execution state remain in owner-private runtime state. The controller does not publish production commit statuses or other runtime evidence to the implementation repository.

Semantic status output is intentionally bounded and does not expose the private control binding, raw request payloads, detailed diagnostics, or credentials.

## GitHub credential boundary

The controller credential is stored outside the repository in an owner-only runtime location. It is used only for read access required by the configured private control source and implementation provenance/CI checks.

The controller requires no GitHub write permission for routine operation. In particular, it must not receive Contents write, Issues write, Pull requests write, Actions write, Commit statuses write, Administration, Deployments write, Secrets write, or equivalent authority that could let it modify its own authorization surface or publish production state.

No GitHub Actions workflow receives this credential or any other VPS/OpenClaw/Nexus/Telegram/model-provider production credential.

## Bootstrap

Bootstrap is an explicitly approved activation operation. The installed controller revision must already equal the approved implementation revision. The bootstrap wrapper requires:

```text
--production-sha <exact implementation revision>
--controller-sha <exact implementation revision>
--control-repository <private owner/repository>
--implementation-repository <distinct implementation owner/repository>
--control-issue <positive issue number>
--owner-login <authorized GitHub login>
--owner-id <authorized positive GitHub user id>
```

Bootstrap validates both repository relationships through GitHub, records the current control-comment watermark, and persists the binding in owner-private controller state. The source tree contains no concrete production binding values.

## Resource preflight

OpenClaw rollout requires at least 2 GiB of free space on the runtime/home, temporary-work, and controller-state filesystems before preparation proceeds, and re-checks the same headroom after creating the verified backup and before the first update mutation. Insufficient headroom is a pre-mutation refusal; the controller does not delete unrelated temporary data to make room.

## Failure semantics

Production mutation remains fail-closed. Unknown or unproven post-mutation outcomes block later production mutation until explicit reconciliation. There is no automatic production retry. Recovery and break-glass paths must preserve exact source/recovery provenance and remain separately approved when required.

## Public-source rule

Tests may use synthetic repositories, identities, issue numbers, SHAs, paths, and credentials placeholders. They must not encode the active private control binding or private Nexus source relationship.
