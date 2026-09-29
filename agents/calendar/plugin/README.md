# Calendar Analytics plugin

OpenClaw-owned deterministic and provider layer for Calendar Agent.

The plugin validates operational analytical configuration, computes review windows and time allocation, exposes a narrow Google Calendar API adapter, and gates the Calendar Agent tool surface fail-closed.

Durable classification rules and meeting-hygiene exceptions live only in the plugin's validated `durableRules` configuration. `calendar_rule_propose` creates bounded in-process proposal state without changing effective configuration. `calendar_rule_commit` accepts only that proposal's opaque ID and is guarded by OpenClaw native allow-once approval before the transactional config mutation can run. Pending proposals expire and are intentionally lost on restart; approved durable rules survive through runtime configuration.

The provider uses Google Application Default Credentials supplied by live runtime state. It exposes only bounded reads plus one classification write. The classification write is admitted only when its payload contains exactly `event_id` and `label_id`, the label is part of the effective analytical configuration, and the adapter can apply it through the Calendar API custom-label field without sending guest updates.
