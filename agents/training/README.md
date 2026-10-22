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

## Active Training release transition

The stage-only `deploy.sh` is intentionally **not** an active-agent updater; it must continue refusing an already activated Training runtime.

For an explicitly owner-approved exceptional upgrade from the **exact frozen active 0.1.3 predecessor** to 0.1.7, `active-upgrade.mjs` provides a bounded deterministic implementation-owned entrypoint. It does **not** create a new controller, authorize its own execution, merge a PR, or claim the Task production controller's authority.

- `node agents/training/active-upgrade.mjs --preflight` is read-only and refuses nonmatching host, source/release, predecessor plugin, predecessor Training tool policy and AGENTS instructions, Training schema/integrity, owner-only Telegram routing, or an active/paused Training Session.
- `node agents/training/active-upgrade.mjs --apply --source-sha <exact-approved-main-sha>` requires **separate production mutation approval** and a frozen, CI-qualified implementation checkout. The SHA argument verifies identity, not authorization. A ChatGPT/agent request is not authorization simply because it can invoke the script.
- The runner uses the supported OpenClaw plugin lifecycle to replace the exact prebuilt plugin archive, updates only the Training agent's tool policy through OpenClaw config patch and the source-owned `AGENTS.md`, and preserves all other agent settings, Telegram owner-only routing, runtime-specific Training identity and Training SQLite. The frozen schema remains v2.
- An owner-private, permission-restricted local recovery set supports reverting plugin, policy and AGENTS instructions to the exact predecessor. If recovery is not proven, the runner leaves a persistent lock and `RECOVERY_REQUIRED` evidence; further mutation is prohibited pending independent reconciliation. The runner **never rewinds Training SQLite**.
- The runner's local recovery set is not a provider-independent backup and is not proof that external Training backup decryption/restoration works. Independent off-host recovery assurance remains a separate readiness concern owned by the private operational recovery source.
- **After a successful runner exit, in-process automatic rollback is no longer available:** the ephemeral config/AGENTS snapshots are securely removed before owner-native Telegram acceptance. Production activation must **not** proceed on runner success alone; an independently qualified and separately authorized post-cutover recovery route is a mandatory activation stop gate. This PR does not implement or authorize post-cutover recovery.

The source has disposable regression coverage for policy-only and running-Gateway plugin replacement, intact Store/identity, exact pinned archives and failure rollback. The actual production control-plane execution plan must additionally establish current-main PR/CI provenance, approved source SHA, exact live predecessor/config, operational backups, Gateway readiness, and post-change native owner-command and Telegram acceptance. No production application is authorized by these tests.
