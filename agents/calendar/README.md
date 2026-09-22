# Calendar Agent

Public non-secret implementation package for the OpenClaw Calendar analytical agent.

Canonical purpose, behavior, authority, lifecycle, time model, review cadence, and acceptance requirements are owned by Nexus. This package owns only reproducible Calendar-specific implementation. Google Calendar owns operational event state; live OpenClaw/provider state owns credentials, sessions, Telegram bindings, native Codex app state, automation instances, and effective configuration.

## v1 implementation boundary

Calendar v1 is intentionally stateless. It contains:

- `workspace/` — persistent runtime instructions and identity files;
- `config/calendar-agent.fragment.json` — non-secret agent identity and workspace paths;
- `config/calendar-tools.json` — the bounded OpenClaw-owned tool surface;
- `plugin/` — deterministic operational-configuration validation, review-window/time-allocation arithmetic, and the Calendar Agent fail-closed tool policy;
- `validate.sh` — deterministic source validation.

Calendar v1 has no Calendar database, no event mirror, and no independent Google credential store. Classification remains on the Google Calendar event through the provider's named event-label mechanism when the production-relevant tool path proves that mechanism.

## Source authority

| Source | Owns |
| --- | --- |
| Nexus | Calendar purpose, analytical principles, agent behavior, authority, lifecycle, cadence, and acceptance contract |
| Google Calendar | Operational calendar events and provider event identity |
| This package | Reproducible non-secret Calendar implementation and configuration schema |
| `runtime-contract.json` | Repository-wide OpenClaw and Node compatibility contract |
| Live OpenClaw/Codex runtime | Effective agent/model/auth configuration, native Google Calendar tool surface, runtime configuration, Telegram route, automation state, and deployment evidence |
| Git history / CI | Source history and non-production validation evidence |

## Operational configuration

Taxonomy, category hierarchy, target allocation, provider event-label IDs/names/colors, designated calendar, and exact production-native Calendar tool identities are runtime configuration. They are deliberately not hard-coded into this repository or Nexus.

The plugin validates that:

- management leaves reference configured management parents;
- service leaves are non-target classifications;
- leaf and provider-label identities are unique;
- the classification-write path can write only one configured leaf label to one event;
- all other model-visible tool calls for the `calendar` agent fail closed unless explicitly admitted.

## Google integration boundary

The preferred v1 path is the native Codex `google-calendar` app using the owner-controlled authenticated Codex account. The Calendar plugin does not implement OAuth and does not receive a second Google credential.

Production activation must prove the actual model-facing tool names and schemas from a fresh Calendar Agent session. The runtime policy is then configured with exact read-tool identities and exactly one bounded classification-label write identity. Unknown or broader Calendar mutation tools remain blocked.

If that native path cannot provide the required bounded event-label write, activation must stop. A direct Google API adapter is a separately justified fallback, not an automatic second integration.

## Validation

Run:

```bash
bash agents/calendar/validate.sh
```

The package CI validates runtime compatibility, source/config shape, taxonomy validation, review-window arithmetic, overlap de-duplication, target calculations, weekend exclusion, fail-closed tool policy, and absence of obvious secret material.

## Production boundary

Source preparation does not activate Calendar Agent.

Activation additionally requires:

- confirmed initial operational taxonomy/targets/labels and designated Google Calendar;
- explicit native `google-calendar` availability through the production Codex account;
- fresh model-facing discovery of the exact Calendar read/write tool surface;
- owner-only Telegram account and route;
- Daily and Biweekly native OpenClaw Automations;
- representative allowed and forbidden behavior tests;
- post-activation Nexus runtime reconciliation.
