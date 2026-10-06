# Calendar Agent

Public non-secret implementation package for the OpenClaw Calendar analytical agent.

Canonical purpose, behavior, authority, lifecycle, time model, review cadence, and acceptance requirements are owned by Nexus. This package owns only reproducible Calendar-specific implementation. Google Calendar owns operational event state; live OpenClaw/provider state owns credentials, sessions, Telegram bindings, automation instances, and effective configuration.

## v1 implementation boundary

Calendar v1 has no independent Calendar state database or operational source. Durable operational rules live only in the validated Calendar plugin configuration; pending approval proposals are short-lived, non-authoritative interaction state stored in the OpenClaw plugin-state keyed store with a bounded TTL so exact proposals remain resolvable across plugin/runtime instance boundaries. The package contains:

- `workspace/` — persistent runtime instructions and identity files;
- `config/calendar-agent.fragment.json` — non-secret agent identity and workspace paths;
- `config/calendar-tools.json` — the bounded OpenClaw-owned tool surface;
- `plugin/` — deterministic operational-configuration validation, durable-rule proposal/approval handling, Google Calendar provider access, review-window/time-allocation arithmetic, and the Calendar Agent fail-closed tool policy;
- `validate.sh` — deterministic source validation.

Calendar v1 has no Calendar database and no event mirror. Classification remains on the Google Calendar event through Google's custom event-label mechanism. Durable classification guidance and meeting-hygiene exceptions persist only in `plugins.entries.calendar-analytics.config.durableRules`. Provider authentication is external runtime state and is never stored in this repository.

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

Taxonomy, category hierarchy, target allocation, provider event-label IDs/names/colors, designated calendar, exact provider-tool identities, and human-approved durable classification/hygiene rules are runtime configuration. They are deliberately not hard-coded into Nexus. Conversation history, Dreaming, and model memory are not operational rule stores.

The plugin validates that:

- management leaves reference configured management parents;
- service leaves are non-target classifications;
- leaf and provider-label identities are unique;
- the classification-write path can write only one configured leaf label to one event;
- durable classification rules reference configured leaf categories;
- durable hygiene exceptions waive at least one default meeting-hygiene requirement;
- durable rule text is bounded so the native approval surface can display the exact proposal in full;
- `calendar_rule_propose` changes no effective configuration;
- `calendar_rule_commit` accepts only an opaque, short-lived `proposal_id`, is protected by native OpenClaw allow-once approval, and mutates only the Calendar plugin's `durableRules` configuration;
- independent create proposals remain valid across unrelated durable-rule changes, while replace/delete proposals fail closed if their exact target rule changed after proposal creation;
- the label-administration path can synchronize only configured analytical label definitions and accepts no model-supplied mutation payload;
- all other model-visible tool calls for the `calendar` agent fail closed unless explicitly admitted.

Pending rule proposals are intentionally ephemeral and bounded. They use OpenClaw plugin-scoped keyed state with a 30-minute TTL and a bounded entry count so the exact proposal can survive ordinary plugin/runtime instance changes without becoming authoritative operational state. Expired or missing proposals require a fresh proposal; an unapproved proposal is never an effective rule.

## Google integration boundary

The v1 provider is an implementation-owned narrow adapter over the official Google Calendar API. The provider surface remains five model-visible tools:

- `calendar_provider_list_events`;
- `calendar_provider_get_event`;
- `calendar_provider_get_labels`;
- `calendar_provider_set_label`;
- `calendar_provider_sync_labels`.

The adapter authenticates through Google Application Default Credentials (ADC) supplied by live runtime state. It requests Calendar event access plus Calendar-property write scope because Google requires `calendar.calendars` to define or rename custom labels. The model-facing tool boundary still restricts Calendar-property mutation to configured analytical label definitions only. No Google credential, refresh token, OAuth client secret, or ADC file is committed here.

Google provider event IDs remain inside the deterministic provider layer. Model-visible event reads expose a short deterministic event reference derived from the provider ID and event date. Before a single-event read or classification write, the provider resolves that reference within a bounded Calendar window, requires exactly one provider event match, then performs a fresh provider read using the original Google event ID. A malformed, stale, missing, or ambiguous reference fails closed rather than allowing the model to reconstruct or mutate provider identity.

`calendar_provider_set_label` performs a fresh event read and a compare-and-set check against the label observed by the agent before mutation. Automatic classification is admitted only when that expected label is absent or the configured technical Unclassified label; an explicit human correction may replace an existing configured analytical label. If the label changed between read and write, the mutation fails closed. When the requested label is already present the call is idempotent; otherwise it sends a conditional Calendar API PATCH containing only `eventLabelId`, with `eventLabelVersion=1`, `sendUpdates=none`, and the current ETag when available.

`calendar_provider_sync_labels` reads the current Calendar resource, merges the configured analytical label definitions into the existing label list by stable label ID, preserves unrelated labels and Calendar properties, updates the Calendar, and verifies that the configured IDs/names/colors persisted. It accepts no model-supplied label body. There is no model-facing general Calendar/event update/create/delete/respond tool.

## Validation

Run:

```bash
bash agents/calendar/validate.sh
```

The package CI validates runtime compatibility, source/config shape, taxonomy and durable-rule validation, proposal/commit semantics, native-approval policy, review-window arithmetic, overlap de-duplication, target calculations, weekend exclusion, provider write bounds, fail-closed tool policy, and absence of obvious secret material.

Before activating or changing a runtime-owned Calendar automation that uses `trigger.script`, validate that script against the exact qualified OpenClaw code-mode runtime rather than Node.js alone.

Qualification must exercise representative fire and skip cases and fail closed when the script relies on globals unavailable in the qualified runtime. Source CI does not substitute for runtime trigger qualification.

## Production boundary

Source preparation does not activate Calendar Agent.

Activation additionally requires:

- confirmed initial operational taxonomy/targets/labels and designated Google Calendar;
- owner-authorized Google ADC with the minimum required scopes; when ADC uses External user OAuth, the OAuth app must be `In production` before issuing the production refresh token; `Testing` authorizations expire after seven days and are not acceptable for production use;
- representative provider read and label-write validation against the designated calendar;
- owner-only Telegram account and route;
- a working native plugin-approval route for Calendar rule commits;
- Daily, Next Workday, and Biweekly native OpenClaw Automations;
- representative allowed and forbidden behavior tests;
- post-activation Nexus runtime reconciliation.
