# Break-glass controller reconciliation

Protected controller or deployment-harness changes cannot self-deploy through the routine production controller. This approved break-glass path reconciles an exact, reviewed implementation `main` revision while preserving owner-private state, operational bindings, and recovery evidence.

There are **two mutually exclusive reconciliation modes**. Select the mode by the actual production runtime state, not to bypass a failing diagnostic.

## Controller-only reconciliation (controller-first upgrade)

Use `--controller-only` when the installed OpenClaw/Task runtime still runs the predecessor and must remain unchanged while the controller is upgraded. This resolves the otherwise circular dependency where the new controller would require an already-deployed target Task runtime.

Before mutation, all of the following are required:

- The runner's authoritative source checkout is clean at the exact approved target `--to` revision. The target is separately approved as the intended current implementation `main`.
- The controller is `ACTIVE`, unblocked, and quiescent; its installed revision equals `--from`. The controller timer and service are stopped; Nexus synchronization is active.
- `controller_revision`, `protected_path_baseline_sha`, and `production_baseline_sha` are all the exact predecessor `--from` revision.
- The durable production runtime source checkout is a real, clean git checkout at `--from`, with the expected implementation origin.
- The target controller must diagnose the **existing** production Task/OpenClaw runtime successfully before changing authoritative state.

From the approved target checkout:

```bash
bash agents/tasks/production-control/reconcile-break-glass.sh \
  --from <installed-controller-sha> \
  --to <exact-approved-current-main-sha> \
  --controller-only \
  --apply
```

No target Task deploy result or `start_is_target=1` is required or accepted in this mode. The runner prepares an independent clean target checkout, installs the target controller from that checkout through the existing installer, and retains the predecessor production source checkout. It verifies a candidate state with:

- `controller_revision = --to`
- `protected_path_baseline_sha = --to`
- `production_baseline_sha = --from`

Only after the target controller reports passing **full local diagnostics against the predecessor production runtime** is that state persisted and the controller timer restarted. The protected-path acceptance marker advances to the separately reviewed target generation; it is not a claim that the Task runtime or its source checkout was deployed at the target SHA.

A later normal OpenClaw rollout (or separately approved Task deployment, when applicable) must prove its own target runtime and advance `production_baseline_sha` through its existing guarded lifecycle. Do not manually rewrite the baseline to close the gap.

## Full reconciliation (target runtime already deployed)

Use this existing mode only after a separately approved break-glass Task Agent operation has proven the exact current `main` Task runtime through the implementation-owned `deploy.sh --apply` entrypoint while the routine production-control timer is disabled.

Provide the owner-private durable result JSON from the exact target revision:

- `PASS / NOOP / mutation_started=false / source_revision=--to`, or
- `PASS / COMPLETE / mutation_started=true / source_revision=--to`.

The target `deploy.sh --preflight` must return `start_is_target=1` after verifying the complete runtime fingerprint.

```bash
bash agents/tasks/production-control/reconcile-break-glass.sh \
  --from <installed-controller-sha> \
  --to <exact-approved-current-main-sha> \
  --deploy-result <absolute-owner-private-task-deploy-result.json> \
  --apply
```

This mode reconciles the durable source checkout and advances `controller_revision`, `protected_path_baseline_sha`, and `production_baseline_sha` to `--to` after passing candidate-state diagnostics.

## Common safety, provenance, and recovery

The caller cannot override the operational binding. The runner validates and preserves `control_repository`, `implementation_repository`, `control_issue`, `owner_login`, and `owner_id` from existing owner-private controller state. It refuses a dirty or wrong target checkout, competing controller work, an active timer/service, or an inactive Nexus sync timer.

Before mutation it backs up the installed controller library, controller state, systemd units, and prior durable controller source checkout. It prepares a clean target checkout with canonical source origin and checks the installed controller revision. Candidate-state diagnostics execute before the authoritative state transition. The reconciliation record captures predecessor and target controller revisions, both baseline revisions, the selected mode, and backup location.

A failure **before** mutation leaves the old controller state untouched with the controller timer stopped. A failure **after** mutation restores the previous controller library, state, systemd units, and source checkout; the controller timer remains stopped. If the restoration cannot be completed, the runner emits `CONTROLLER_BREAK_GLASS_RECONCILIATION_RECOVERY_INCOMPLETE` with exit status 3. A failure is not authorization to bypass validation or retry a defective target without investigation.

Following an approved production reconciliation, issue a fresh owner-authored `/diagnose tasks` request to obtain current production evidence. This document is an implementation procedure, not a grant of production execution approval.
