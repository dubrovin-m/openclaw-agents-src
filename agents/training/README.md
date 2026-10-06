# Training Agent

Public non-secret implementation of the OpenClaw Training Agent.

Canonical purpose, behavior, authority, lifecycle, and acceptance scenarios are owned by Nexus. This package owns the reproducible implementation. The live runtime owns actual deployment, credentials, Telegram routing, and the private Training SQLite database.

## v1 implementation boundary

- `plugin/` owns the typed OpenClaw tool surface and deterministic Training Service.
- `config/` owns non-secret agent and tool-policy fragments.
- `workspace/` owns persistent runtime instructions.
- migration and provider-independent recovery are added within this package before activation.
- no production Training data, credentials, private Nexus content, or runtime evidence may enter this public repository.

Fitness remains authoritative until the canonical migration, recovery, and activation gates are completed.

The first implementation slice intentionally uses the typed plugin directly over `node:sqlite`; it does not introduce a standalone generated Training CLI because no independent CLI requirement has been demonstrated.

## Acceptance evidence

See [`ACCEPTANCE.md`](ACCEPTANCE.md) for the implementation evidence map.

## Deployment staging

The v1 release contains a reproducible frozen plugin archive and an implementation-owned stage-only deployment entrypoint.

`deploy.sh --preflight` validates the exact OpenClaw/runtime contract, release identity, artifact checksum, workspace hashes, current config, and absence or exact staged state. `deploy.sh --apply` may then stage only the frozen plugin and Training workspace.

The stage contract intentionally leaves the Training plugin disabled and does **not** register the Training agent, create a Training database, configure model/authentication, create a Telegram binding, restart the Gateway, or switch operational authority away from Fitness. A failed stage uses the OpenClaw plugin uninstall path and restores the exact predecessor config.

Production activation remains a separate governed step after private Fitness migration/reconciliation, recovery qualification, runtime identity/authentication, owner-only Telegram routing, and live acceptance gates.
