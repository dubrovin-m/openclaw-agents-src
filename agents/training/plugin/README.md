# OpenClaw Training plugin

Typed owner-scoped tools over the private Training SQLite store.

## Authority

The plugin is intentionally unavailable unless the runtime reports:
- `agentId === "training"`
- `senderIsOwner === true`

Mutation tools additionally require a live `assertInvocationCurrent` guard before entering the synchronous SQLite mutation path.

The plugin does not expose generic SQL, filesystem, shell, Gateway, scheduler, or cross-agent mutation.

## Current slice

This initial implementation covers:
- Training Store schema v1
- program recommendation reads
- ordered program slot selection
- durable strength prescriptions
- exact-as-prescribed and explicit actual set completion
- defer / skip / finish / void
- deterministic cursor advancement
- basic anomaly rejection

Conditioning execution, corrections, program version changes, migration, learning operations, and recovery are added in later phases before activation.
