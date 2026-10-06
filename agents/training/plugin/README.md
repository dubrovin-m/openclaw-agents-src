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

## Idempotency

Training mutations use layered idempotency:

1. the repository-qualified OpenClaw Telegram ingress persistently deduplicates provider messages by account, bot, chat, and Telegram message id before agent execution;
2. the Training plugin atomically records each successful mutation by OpenClaw tool-call id plus operation name and input hash in the same SQLite transaction as the mutation;
3. domain state transitions remain semantically idempotent where a user can legitimately repeat an instruction.

A repeated tool-call id with different input fails closed. Distinct operation names may share one tool-call lineage without colliding. The Training Store does not fabricate or accept a model-supplied Telegram message id because that trusted provider identity is not exposed through the qualified generic plugin tool context.
