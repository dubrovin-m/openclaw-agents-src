# Calendar Analytics plugin

OpenClaw-owned deterministic layer for Calendar Agent.

It intentionally does not call Google Calendar. Native Google Calendar access remains owned by the Codex app path. This plugin validates operational analytical configuration, computes review windows and time allocation, and gates the Calendar Agent tool surface fail-closed.

The production configuration must use exact native tool identities observed through a fresh Calendar Agent Codex session. The classification write is admitted only when its payload contains exactly `event_id` and `label_id`, and the label is one of the configured leaf labels or the configured technical Unclassified label.
