# Investments Agent

Private non-secret implementation package for the OpenClaw Investments advisory agent.

Canonical purpose, policy, review procedure, authority, and lifecycle are owned by Nexus. Portfolio Hub owns normalized operational investment data and deterministic portfolio analytics. This package owns only reproducible non-secret Investments-agent workspace, bounded Portfolio Hub tool integration, and configuration fragments. Live OpenClaw and external providers own actual model/auth configuration, Telegram binding, automation instances, credentials, and execution state.

## v1 implementation boundary

Investments v1 contains:
- `workspace/` — runtime instructions and identity files;
- `config/investments-agent.fragment.json` — non-secret agent identity/workspace paths;
- `config/investments-tools.json` — finite read-only model-visible tool policy;
- `plugin/` — two bounded read-only Portfolio Hub tools;
- `validate.sh` — deterministic source validation.

It has no trading integration, provider write credentials, database of its own, portfolio-state mutation, Nexus write path, custom scheduler, or persistent agent memory.

## Tool boundary

The finite model-visible allowlist is:
- `read` — only inside the Investments workspace, including the synchronized read-only Nexus checkout;
- `investment_weekly_review` — one consolidated read-only Portfolio Hub review payload;
- `investment_holdings` — current normalized holdings for on-demand analysis;
- `web_search` and `web_fetch` — current external evidence when materially required.

The custom plugin launches only fixed Portfolio Hub Python modules with structured bounded arguments. The model cannot supply a command, Python module, database path, executable path, working directory, environment variable, or filesystem path.

## Production boundary

Source preparation does not activate Investments.

Production activation requires a separately validated runtime step that establishes:
- the approved live Nexus agent contract and Weekly Portfolio Review Skill;
- an agent-local model/auth route;
- a dedicated owner-only Telegram binding;
- read-only Nexus delivery into the Investments workspace;
- the Portfolio Hub plugin configured to the registered production root and Python interpreter;
- effective finite tool policy;
- a native weekly OpenClaw Automation delivering the review to Telegram;
- representative allowed and forbidden tool-path validation;
- one fresh ordinary Telegram review turn using current Portfolio Hub data.

Until those conditions are met and Nexus runtime state is reconciled, this package is a candidate implementation rather than an active Investments runtime.
