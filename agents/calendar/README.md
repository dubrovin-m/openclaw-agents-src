# Calendar Agent

Public non-secret implementation package for the OpenClaw Calendar analytical agent.

Canonical purpose, behavior, authority, lifecycle, time model, review cadence, and acceptance requirements are owned by Nexus. This package owns only reproducible Calendar-specific implementation. Google Calendar owns operational event state; live OpenClaw/provider state owns credentials, sessions, Telegram bindings, automation instances, and effective configuration.

## v1 implementation boundary

Calendar v1 is intentionally stateless. It contains:

- `workspace/` — persistent runtime instructions and identity files;
- `config/calendar-agent.fragment.json` — non-secret agent identity and workspace paths;
- `config/calendar-tools.json` — the bounded OpenClaw-owned tool surface;
- `plugin/` — deterministic operational-configuration validation, Google Calendar provider access, review-window/time-allocation arithmetic, and the Calendar Agent fail-closed tool policy;
- `validate.sh` — deterministic source validation.

Calendar v1 has no Calendar database and no event mirror. Classification remains on the Google Calendar event through Google's custom event-label mechanism. Provider authentication is external runtime state and is never stored in this repository.

## Source authority

| Source | Owns |
| --- | --- |
| Nexus | Calendar purpose, analytical principles, agent behavior, authority, lifecycle, cadence, and acceptance contract |
| Google Calendar | Operational calendar events, provider event identity, custom labels, and Calendar API behavior |
| This package | Reproducible non-secret Calendar implementation and configuration schema |
| `runtime-contract.json` | Repository-wide OpenClaw and Node compatibility contract |
| Live OpenClaw runtime | Effective agent/model/auth configuration, provider credentials, runtime configuration, Telegram route, automation state, and deployment evidence |
| Git history / CI | Source history and non-production validation evidence |

## Operational configuration

Taxonomy, category hierarchy, target allocation, provider event-label IDs/names/colors, designated calendar, and exact provider-tool identities are runtime configuration. They are deliberately not hard-coded into Nexus.

The plugin validates that:

- management leaves reference configured management parents;
- service leaves are non-target classifications;
- leaf and provider-label identities are unique;
- the classification-write path can write only one configured leaf label to one event;
- the label-administration path can synchronize only configured analytical label definitions and accepts no model-supplied mutation payload;
- all other model-visible tool calls for the `calendar` agent fail closed unless explicitly admitted.

## Google integration boundary

The v1 provider is an implementation-owned narrow adapter over the official Google Calendar API. The model sees only five provider tools:

- `calendar_provider_list_events`;
- `calendar_provider_get_event`;
- `calendar_provider_get_labels`;
- `calendar_provider_set_label`;
- `calendar_provider_sync_labels`.

The adapter authenticates through Google Application Default Credentials (ADC) supplied by live runtime state. It requests Calendar event access plus Calendar-property write scope because Google requires `calendar.calendars` to define or rename custom labels. The model-facing tool boundary still restricts Calendar-property mutation to configured analytical label definitions only. No Google credential, refresh token, OAuth client secret, or ADC file is committed here.

`calendar_provider_set_label` performs a fresh event read, returns idempotently when the requested label is already present, and otherwise sends a conditional Calendar API PATCH containing only `eventLabelId`, with `eventLabelVersion=1`, `sendUpdates=none`, and the current ETag when available.

`calendar_provider_sync_labels` reads the current Calendar resource, merges the configured analytical label definitions into the existing label list by stable label ID, preserves unrelated labels and Calendar properties, updates the Calendar, and verifies that the configured IDs/names/colors persisted. It accepts no model-supplied label body. There is no model-facing general Calendar/event update/create/delete/respond tool.

## Validation

Run:

```bash
bash agents/calendar/validate.sh
```

The package CI validates runtime compatibility, source/config shape, taxonomy validation, review-window arithmetic, overlap de-duplication, target calculations, weekend exclusion, provider write bounds, fail-closed tool policy, and absence of obvious secret material.

## Production boundary

Source preparation does not activate Calendar Agent.

Activation additionally requires:

- confirmed initial operational taxonomy/targets/labels and designated Google Calendar;
- owner-authorized Google ADC with the minimum required scopes;
- representative provider read and label-write validation against the designated calendar;
- owner-only Telegram account and route;
- Daily and Biweekly native OpenClaw Automations;
- representative allowed and forbidden behavior tests;
- post-activation Nexus runtime reconciliation.
