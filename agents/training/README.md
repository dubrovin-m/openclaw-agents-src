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

For an explicitly owner-approved exceptional upgrade from the **exact frozen active 0.1.3 predecessor** to 0.1.8, `active-upgrade.mjs` provides a bounded deterministic implementation-owned entrypoint. It does **not** create a new controller, authorize its own execution, merge a PR, or claim the Task production controller's authority.

- `node agents/training/active-upgrade.mjs --preflight` is read-only and refuses nonmatching host, source/release, predecessor plugin, predecessor Training tool policy and AGENTS instructions, Training schema/integrity, owner-only Telegram routing, or an active/paused Training Session.
- `node agents/training/active-upgrade.mjs --apply --source-sha <exact-approved-main-sha>` requires **separate production mutation approval** and a frozen, CI-qualified implementation checkout. The SHA argument verifies identity, not authorization. A ChatGPT/agent request is not authorization simply because it can invoke the script.
- Successful `--apply` emits `APPLIED_PENDING_ACCEPTANCE`, preserving a private config/AGENTS recovery set and an interlock; this is **not** final acceptance. Independently verify the owner-native Telegram command, effective tools/route, DB integrity and Gateway behavior before any further production operation.
- After documented owner-native acceptance, a **separately authorized** `--finalize --source-sha <same-sha>` rechecks the target and immutable recovery evidence, removes private snapshots, records success and releases the lock. If native acceptance fails instead, `--rollback --source-sha <same-sha>` rechecks target/Store/identity and restores the exact 0.1.3 plugin, tools and AGENTS, then reloads Gateway. Neither path rewinds Training SQLite. Any unknown state, snapshot tamper, Store change or unproven rollback leaves a hard stop for independent reconciliation.
- The runner uses the supported OpenClaw plugin lifecycle to replace the exact prebuilt plugin archive, updates only the Training agent's tool policy through OpenClaw config patch and the source-owned `AGENTS.md`, and preserves all other agent settings, Telegram owner-only routing, runtime-specific Training identity and Training SQLite. The frozen schema remains v2.
- An owner-private, permission-restricted local recovery set supports reverting plugin, policy and AGENTS instructions to the exact predecessor. If recovery is not proven, the runner leaves a persistent lock and `RECOVERY_REQUIRED` evidence; further mutation is prohibited pending independent reconciliation. The runner **never rewinds Training SQLite**.
- The runner's local recovery set is not a provider-independent backup and is not proof that external Training backup decryption/restoration works. Independent off-host recovery assurance remains a separate readiness concern owned by the private operational recovery source.
- The rollback window persists across runner exits and closes only on explicit finalization following independent native acceptance. Store identity uses a consistent SQLite logical snapshot, including committed WAL contents; the main SQLite file hash alone is insufficient. After a proven rollback, a separately authorized retry archives the terminal receipt before creating a fresh recovery set; interrupted or unproven states remain locked out. Retained local snapshots contain sensitive provider configuration and are mode 0600 under private directories (0700); do not copy them to CI logs, Nexus or repositories. Recovery is not proof of Telegram acceptance and is not a provider-independent backup.

The source has disposable regression coverage for policy-only and running-Gateway plugin replacement, intact Store/identity, exact pinned archives and failure rollback. The actual production control-plane execution plan must additionally establish current-main PR/CI provenance, approved source SHA, exact live predecessor/config, operational backups, Gateway readiness, and post-change native owner-command and Telegram acceptance. No production application is authorized by these tests.

## Imported barbell load comparability

Migrated Fitness barbell working-set loads have uncertain inclusion of the bar itself, while the active `TOTAL_EXTERNAL` contract counts the full external mass. Training preserves these historical facts, but excludes the migrated `TOTAL_EXTERNAL`/`barbell` session-exercise records (identified through `migration_records`) from **both** comparable progression exposures and the independent anomaly-check baseline. Modern recorded barbell work remains comparable; other load semantics are unchanged. With no comparable barbell exposure, prescription falls back to approved initial policy or remains without a candidate, never to a fabricated conversion. Schema v2 and migrated history are unchanged.
