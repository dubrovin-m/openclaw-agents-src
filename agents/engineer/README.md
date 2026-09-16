# Engineer Agent

Private non-secret implementation package for the OpenClaw Engineer execution agent.

Canonical purpose, supported cases, authority, lifecycle, and expected runtime relationships are owned by Nexus. This package owns only reproducible Engineer-specific implementation. The live OpenClaw runtime and external providers own actual configuration, credentials, sessions, permissions, channel bindings, and execution state.

## v0 implementation boundary

Engineer v0 is intentionally small. This package contains:

- `workspace/` — runtime instructions and identity files;
- `config/engineer-agent.fragment.json` — non-secret agent identity and workspace paths;
- `config/engineer-tools.json` — the bounded model-visible tool and host-exec policy;
- `bin/engineer-vps-maintenance-snapshot` — fixed-argument deterministic read-only evidence collector for the registered scheduled VPS maintenance case;
- `tests/maintenance_snapshot_test.py` — collector boundary tests;
- `validate.sh` — deterministic source validation.

Engineer v0 has no custom plugin, backend, database, production controller, custom scheduler, or shared infrastructure of its own. The maintenance collector is a bounded read-only helper: it accepts only `weekly` or `monthly`, gathers operational evidence, and has no mutation interface. Registered native OpenClaw Automation instances are runtime-owned provider state and are not defined by this package.

The package does not contain or provision model credentials, GitHub credentials, Telegram bot tokens, Nexus write access, host approval allowlists, or other secrets/provider-managed state.

## Source authority

| Source | Owns |
| --- | --- |
| Nexus | Engineer responsibility, supported cases, authority, lifecycle, acceptance contract, and expected runtime relationships |
| This package | Reproducible non-secret Engineer workspace and configuration fragments |
| `runtime-contract.json` | Repository-wide OpenClaw and Node compatibility contract |
| Live OpenClaw runtime | Actual installation, effective configuration, sessions, credentials, approvals, services, and runtime evidence |
| GitHub provider state | Current PR, review, CI, and repository-managed state within the Engineer read-only boundary |
| Git history | Previous implementation history |

## Tool boundary

The initial tool surface is deliberately limited to `read`, `exec`, and `process`.

- `read` is restricted to the Engineer workspace.
- `exec` targets the Gateway host and uses `mode: "auto"`: allowlist matches run directly, while misses pass through OpenClaw's native automatic reviewer before any fallback to owner approval.
- `strictInlineEval` is enabled so inline interpreter/evaluator forms still require reviewer or explicit approval rather than becoming silently trusted through a broad executable allowlist.
- `process` exists only to manage long-running `exec` sessions owned by the same Engineer agent.
- OpenClaw filesystem mutation tools and unrelated browser, scheduling, cross-agent, node, and gateway administration surfaces are denied.

Automatic exec review reduces command-by-command approval friction inside an otherwise authorized supported case. It does not grant new case scope, source-write authority, elevated execution, or permission to bypass the material human approval boundary.

Disabling filesystem tools does not make shell execution read-only. Runtime exec approvals remain the enforcement layer for host commands.

## Validation

Run:

```bash
bash validate.sh
```

The package CI must validate the repository runtime contract, source layout, JSON configuration, least-privilege tool policy, workspace boundary, the maintenance collector syntax/tests and non-shell mutation boundary, and absence of obvious secret material.

## Production boundary

Source preparation does not activate Engineer.

Production activation requires a separately validated runtime step that establishes, at minimum:

- an agent-local model/auth route without silently inheriting an unintended credential;
- the intended inbound channel binding;
- effective per-agent tool policy and host exec approval behavior;
- read-only access to the admitted GitHub implementation/PR/CI evidence path;
- read-only Nexus delivery;
- representative allowed and forbidden behavioral validation.

Until those conditions are validated and Nexus runtime state is reconciled, this package must not be represented as an active Engineer runtime.
