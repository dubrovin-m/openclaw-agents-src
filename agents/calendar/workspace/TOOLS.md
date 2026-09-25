# Calendar tools

Use only the model-visible tools admitted by the effective Calendar runtime.

OpenClaw-owned deterministic tools:

- `calendar_config_get` — current operational taxonomy, target model, designated calendar, provider labels, and admitted provider-tool identities;
- `calendar_review_window` — deterministic Daily/Next-Workday/Biweekly date and provider-query window;
- `calendar_analyze` — deterministic time arithmetic, overlap handling, classification coverage, and target comparison.

OpenClaw-owned Google Calendar provider tools:

- `calendar_provider_list_events` — read events in one bounded time window from the designated calendar;
- `calendar_provider_get_event` — read one event by the deterministic event reference returned by Calendar reads;
- `calendar_provider_get_labels` — read custom event labels from the designated calendar;
- `calendar_provider_set_label` — set only one configured analytical event label using that deterministic event reference.

The fail-closed Calendar policy blocks every other OpenClaw or provider tool for the `calendar` agent. Google credentials are runtime state and must never be copied into workspace files or prompts.
