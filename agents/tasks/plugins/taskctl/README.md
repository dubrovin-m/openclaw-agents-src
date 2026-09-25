# Taskctl plugin 0.4.27

Typed tool plugin for the fixed local Task Agent executable and bounded Task Agent production-control interface. The exact qualified OpenClaw host version is owned by the repository `runtime-contract.json` and mirrored in package/release metadata.

The deterministic `taskctl` backend is implementation `0.4.14` with SQLite schema v9. The plugin defines 63 model-visible Task Agent data tools, one for each deterministic action, plus one optional `task_production_control` tool. It also registers three scheduler-only tools that are intentionally excluded from the ordinary model-visible tool surface. The manifest therefore declares 67 tool contracts, while the ordinary model-visible surface contains 64. It does not expose a generic multiplexed `taskctl(action, payload)` or generic shell tool.

## Batch 6

Batch 6 keeps the existing Task data model, SQLite schema, tool inventory, permissions, and production-control boundary while tightening and extending behavior within the approved Nexus contract:

- `task_label_add` and `task_label_remove` accept only `operation_key`, `task_id`, and canonical `label_id`; Label names are resolved first through `label_resolve` and association mutations cannot create Labels;
- deterministic OPEN Task lists use deadline-first ordering with presentation-only clustering by the first canonical Label in deterministic Label order, without a persisted primary Label;
- Fast Create is implemented in the Task Agent workspace instructions using the existing `task_create` action for exactly one sufficiently structured Task; ordinary capture remains Inbox-first;
- duplicate detection remains outside synchronous Fast Create;
- `task_production_control` semantics and activation boundary are unchanged by Batch 6.

## Contract architecture

`src/contract.ts` contains the single Task data action registry. Each action definition owns:

- fixed backend argv;
- allowed and required root fields;
- exact-one field groups where applicable;
- model-facing label;
- semantic model-facing description.

All 63 Task data parameter schemas are generated through the same registry-driven path. Entity identifiers are typed to the deterministic entity boundary (`I-*`, `T-*`, `P-*`, or `L-*`) before backend execution. The deterministic validator remains an independent fail-closed boundary and continues to enforce value-level and semantic constraints that are not fully represented in provider-facing JSON Schema.

## Task production control

`task_production_control` is a separate optional tool with exactly three actions:

- `status` — return bounded controller state without a human approval;
- `diagnose` — run the registered bounded read-only Task Agent diagnostics without a human approval;
- `deploy` with an exact 40-character lowercase Git SHA — request one deterministic deployment after a critical `allow-once` / `deny` plugin approval.

The production-control tool is restricted by the plugin hook to agent `main`. It is intentionally absent from the dedicated Task Agent tool allowlist. Adding the tool to the plugin manifest therefore does not grant the `tasks` agent production-control authority.

The plugin does not translate these actions into shell commands. It imports the installed registered production controller module and invokes only the fixed semantic operation exports. Deployment validation, provenance, CI requirements, protected-path checks, detached execution, rollback, and durable evidence remain controller-owned.

The existing owner-authorized GitHub production-control request channel remains supported. The semantic ingress does not require or grant GitHub Issues write permission to the VPS controller credential and does not weaken raw host `exec` policy.

## Validation

The plugin regression suite verifies that:

- all 63 deterministic Task actions plus the one optional production-control tool are registered exactly once;
- no generic `taskctl` or shell dispatcher is model-visible;
- every Task data root schema comes from the single action registry;
- all 64 ordinary model-visible contracts survive the pinned OpenAI Responses normalization path;
- every Task data tool has a semantic description rather than a mechanical fallback;
- the Task Label association contracts remain canonical-ID-only through model-visible schema normalization;
- entity-id, the remaining `task_create` exact-one boundary, status-transition, and fail-closed boundaries remain intact;
- malformed production-control calls fail before controller invocation;
- non-`main` production-control calls are blocked;
- only `deploy` requests a human approval, and that approval permits only `allow-once` or `deny`;
- the existing deterministic Task backend integration path still passes.

Calendar-date semantic validation intentionally remains in the sanitizer rather than being duplicated in the provider-facing regular-expression schema; impossible dates therefore fail closed before `taskctl` execution.

## Validate and package

```bash
npm ci
npm test
npm run build
npm run plugin:build
npm run plugin:check
npm run plugin:validate
npm pack --pack-destination ../../artifacts
```

A source release does not deploy itself. Production deployment and activation of the semantic production-control tool remain separate governed runtime operations through the registered Task Agent production-control boundary.
