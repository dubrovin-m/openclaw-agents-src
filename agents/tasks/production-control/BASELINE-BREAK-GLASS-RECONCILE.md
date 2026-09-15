# Baseline-only break-glass reconciliation

Use this path only after a separately approved exceptional Task Agent deployment has already proven an exact Task runtime revision through that target revision's implementation-owned `agents/tasks/deploy.sh --apply`, but the installed production controller must remain on its existing revision.

This path exists for a narrow case where Task runtime provenance and controller implementation provenance intentionally diverge:

- `controller_revision` remains the exact installed controller revision;
- `production_baseline_sha` advances to the exact proven Task runtime revision;
- the durable production source checkout advances to the same production baseline revision;
- controller files and systemd units are not reinstalled or rewritten.

It is not a general alternative to routine `/deploy tasks <sha>` and must not be used to bypass current-main, CI, protected-path, or approval gates for ordinary releases.

## Preconditions

Before invoking the runner:

1. the Task deployment must already have completed through the exact target revision's `agents/tasks/deploy.sh --apply` and produced an owner-private durable result JSON;
2. the deployment result must be either `PASS / COMPLETE / mutation_started=true` or `PASS / NOOP / mutation_started=false`, with `source_revision` equal to the target production baseline;
3. for `COMPLETE`, the referenced Task recovery set must still exist and pass the target revision's independent `recover.sh --inspect` validation;
4. the current controller state must be `ACTIVE`, unblocked, and quiescent;
5. the installed controller revision and `controller_revision` must equal the separately supplied controller SHA;
6. the current `production_baseline_sha` and durable production source checkout must equal the supplied old baseline SHA;
7. the routine production-control timer and service must already be inactive, while Nexus synchronization remains active;
8. the caller must supply a clean canonical checkout of the exact target production baseline and a clean checkout containing the exact approved runner revision.

## Apply

From the exact approved runner checkout:

```bash
bash agents/tasks/production-control/reconcile-baseline-break-glass.sh \
  --runner <exact-runner-revision> \
  --controller <installed-controller-revision> \
  --from-baseline <current-production-baseline> \
  --to-baseline <exact-proven-task-runtime-revision> \
  --target-source <absolute-clean-target-source-checkout> \
  --deploy-result <absolute-owner-private-task-deploy-result.json> \
  --apply
```

The runner validates all immutable identities before mutation. It then:

1. requires the target Task `deploy.sh --preflight` to prove that the live plugin already equals the target generation;
2. prepares a local recovery snapshot of controller state and the durable production source checkout;
3. prepares a credential-free copy of the target source at the exact target baseline;
4. constructs a candidate controller state that changes only `production_baseline_sha` and runs the already-installed controller's local diagnostics against that candidate state and target source;
5. only after candidate diagnostics pass, replaces the durable production source and advances `production_baseline_sha`, leaving `controller_revision` and installed controller files unchanged;
6. runs the installed controller's local diagnostics again against authoritative state;
7. starts the routine production-control timer and requires it active;
8. writes an owner-private reconciliation result under the controller recovery directory.

## Failure and recovery

Any failure before state/source mutation leaves the old baseline authoritative and the routine production-control timer inactive.

Any failure after mutation restores the previous controller state and durable production source from the local recovery set and leaves the routine production-control timer inactive. The installed controller revision is checked again during recovery and must remain unchanged.

If recovery cannot be proven, the runner emits `TASK_PRODUCTION_BASELINE_BREAK_GLASS_RECONCILIATION_RECOVERY_INCOMPLETE`, exits with status 3, and no further production mutation is authorized until the state is independently reconciled.

A failed run does not authorize manual edits to controller state, durable source provenance, Task SQLite, OpenClaw configuration, or deployment evidence.

## Validation after success

Use fresh diagnostics from the installed controller. A successful baseline-only reconciliation must show:

- installed controller revision and `controller_revision` unchanged;
- `production_baseline_sha` equal to the exact deployed Task revision;
- durable production source equal to that same baseline;
- release/runtime diagnostics healthy;
- routine production-control timer active.

User-facing behavior must then be validated separately through the affected Task Agent capability; baseline reconciliation itself is not evidence that the original product defect is fixed end-to-end.
