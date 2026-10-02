# Pre-mutation UNKNOWN reconciliation

This is a bounded break-glass path for a production operation that the controller recorded as `UNKNOWN` even though durable operation evidence and independent diagnostics can prove that the accepted production baseline was not mutated.

It is not a retry path and it does not deploy code, change OpenClaw, change plugins, advance any baseline SHA, modify the controller revision, or broaden production authority. The routine production-control timer and service must already be inactive.

The reconciler accepts only one exact request identity and explicit expected controller, protected-path baseline, production baseline, predecessor OpenClaw version, target source SHA, and target OpenClaw version. It additionally requires:

- controller state is `ACTIVE` and blocked specifically by that request ending `UNKNOWN`;
- the request is an owner-authorized GitHub `rollout-openclaw` record with no active operation;
- durable evidence is the known pre-mutation `TASK_PREDEPLOY` failure shape, with `mutation_started=false`, no Task deployment result, and a verified owner-private backup archive;
- installed controller revision matches the expected controller SHA;
- the reconciliation runner is executed from the explicitly expected clean reviewed repository revision;
- Gateway and Nexus sync are active;
- full private diagnostics prove the current production baseline, OpenClaw predecessor version, Task release, plugin state, database, config, and provenance are healthy.

Without `--apply` the command is read-only. With `--apply` it atomically changes only controller state: the request becomes `BLOCKED_PRE_MUTATION`, a reconciliation record is attached, `deployment_blocked` is cleared, and current diagnostics are recorded. Controller/protected/production SHAs and request history/watermark are preserved. A recovery copy of state and evidence is written before mutation. Post-reconciliation diagnostics must pass or the previous state is restored.

Example shape:

```text
bash agents/tasks/production-control/reconcile-pre-mutation-unknown.sh \
  --request-id <id> \
  --expected-target-sha <request-target-sha> \
  --expected-production-sha <current-production-baseline> \
  --expected-controller-sha <installed-controller-sha> \
  --expected-protected-sha <protected-path-baseline> \
  --expected-openclaw-version <predecessor-version> \
  --expected-target-openclaw-version <target-version> \
  --expected-runner-sha <exact-reviewed-runner-sha> \
  --apply
```

After successful reconciliation, do not retry the failed target unchanged. Correct and qualify the preparation/controller defect first, then use the normal governed controller or existing controller break-glass procedure as appropriate.
