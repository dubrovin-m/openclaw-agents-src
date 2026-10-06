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
