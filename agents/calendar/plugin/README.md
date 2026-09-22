# Calendar Analytics plugin

OpenClaw-owned deterministic and provider layer for Calendar Agent.

The plugin validates operational analytical configuration, computes review windows and time allocation, exposes a narrow Google Calendar API adapter, and gates the Calendar Agent tool surface fail-closed.

The provider uses Google Application Default Credentials supplied by live runtime state. It exposes only bounded reads plus one classification write. The classification write is admitted only when its payload contains exactly `event_id` and `label_id`, the label is part of the effective analytical configuration, and the adapter can apply it through the Calendar API custom-label field without sending guest updates.
