# Investment Analytics plugin

Read-only OpenClaw tool plugin for the Investments Agent.

It exposes only two bounded Portfolio Hub reads:
- `investment_weekly_review` — cash-flow-adjusted weekly performance, current portfolio structure, and deterministic risk metrics;
- `investment_holdings` — current normalized holdings for on-demand instrument analysis.

The plugin never accepts a command, module, database path, or filesystem path from the model. Runtime configuration supplies the Portfolio Hub root and Python executable; the model can vary only bounded review dates/lookback and holdings count.

No trade, provider mutation, Portfolio Hub mutation, Nexus mutation, shell, scheduler, or credential access is exposed.
