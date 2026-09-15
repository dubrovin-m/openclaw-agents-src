# Break-glass controller reconciliation

Use this path only after a separately approved break-glass Task Agent operation has already proven the exact current `main` Task runtime through the implementation-owned `deploy.sh --apply` entrypoint while the routine production-control timer is disabled.

It covers both rare protected-path cases:

- the exact target was already effective and `deploy.sh --apply` returned `PASS / NOOP / mutation_started=false`;
- the approved break-glass operation changed the Task runtime and returned `PASS / COMPLETE / mutation_started=true`.

Routine plugin-only Task releases continue to use the normal production controller. This path exists only because changes to controller, deployment, installation, recovery, or other protected harness files cannot self-deploy through that controller.

## Preconditions

The source checkout must be clean and at the exact approved current-main revision supplied as `--to`.

The existing controller must be `ACTIVE`, unblocked, quiescent, and installed at the exact `--from` revision. The routine controller timer and polling service must already be inactive. Nexus synchronization must be active.

The caller supplies the owner-private durable result JSON produced by the exact target revision's preceding `agents/tasks/deploy.sh --apply`. Reconciliation accepts only either:

- `result=PASS`, `stage=NOOP`, `mutation_started=false`, `source_revision=<exact --to SHA>`; or
- `result=PASS`, `stage=COMPLETE`, `mutation_started=true`, `source_revision=<exact --to SHA>`.

The target `deploy.sh --preflight` must also pass with the current plugin equal to the target plugin. Because a target plugin cannot also be an eligible predecessor, that condition establishes that the live Task runtime remains the exact target generation at reconciliation time.

## Apply

From the exact approved target checkout:

```bash
bash agents/tasks/production-control/reconcile-break-glass.sh \
  --from <installed-controller-sha> \
  --to <exact-current-main-sha> \
  --deploy-result <absolute-owner-private-task-deploy-result.json> \
  --apply
```

Before mutation the runner snapshots the installed controller library, controller state, user systemd units, and the current durable controller source checkout when present. It also prepares an independent clean target source checkout from the exact approved repository revision and rewrites only its `origin` URL to the canonical repository URL, without copying caller credential state.

It then:

1. installs the exact target source checkout as the durable controller source provenance;
2. installs controller files from the exact target checkout through the existing production-control installer;
3. requires installed controller provenance and durable source provenance to equal `--to`;
4. creates an owner-private candidate state copy in the reconciliation backup with `controller_revision` and `production_baseline_sha` set to `--to`, while leaving the authoritative controller state unchanged;
5. runs target local controller diagnostics against that candidate state and exact target source checkout, so runtime, release, controller, source, deployment-evidence, and provenance checks can validate the prospective state before it becomes authoritative;
6. only after those diagnostics pass, preserves request history, watermark, minimum-comment boundary, deployment block state, and other durable controller state while advancing authoritative `controller_revision` and `production_baseline_sha` to the exact proven target;
7. starts the routine production-control timer and requires it active.

The controller remains `ACTIVE`. No second Task runtime deployment is performed.

After success, use a fresh owner-authored `/diagnose tasks` request to publish current production evidence from the reconciled revision.

## Failure and recovery

Any failure before controller/source mutation leaves the old controller state untouched and the timer inactive.

Any failure after mutation restores the previous controller library, controller state, systemd units, and previous durable controller source checkout from the local recovery set and leaves the controller timer inactive. If restoration cannot be proven, the runner emits `CONTROLLER_BREAK_GLASS_RECONCILIATION_RECOVERY_INCOMPLETE` and exits with status 3.

A failed reconciliation does not authorize retrying the same defective target or manually editing controller state. Preparation-owned defects return to source preparation and validation before another separately approved break-glass attempt.
