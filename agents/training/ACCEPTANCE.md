# Training Agent Acceptance Evidence

This file maps the canonical Nexus `TRA-*` acceptance scenarios to implementation evidence and remaining activation work.

It is **not** a behavioral contract. The canonical expected behavior remains `Areas/Health/Physical Training/Training Agent Acceptance Tests.md` in Nexus.

## Status vocabulary

- **SOURCE-QUALIFIED** — deterministic implementation evidence is present and passes in source qualification.
- **SOURCE+ACTIVATION** — deterministic/source mechanics are qualified; the model-mediated or live-runtime portion still requires activation-time conversational/integration validation.
- **BEHAVIORAL-ACTIVATION** — intentionally model-mediated behavior governed by the workspace; Nexus does not require a standing pre-production model-qualification harness.
- **SOURCE+PRODUCTION** — synthetic/source qualification passes, but the corresponding private production-data/provider exercise remains an activation gate.
- **DEFERRED-FITBIT** — intentionally outside Training Agent v1 activation scope; must be qualified when Fitbit integration is activated.
- **PRODUCTION-GATE** — cannot be completed truthfully in source alone and must pass before or during explicit operational activation.

No row marked **GAP** is acceptable for source freeze.

## Session recommendation and selection

| ID | Status | Evidence / remaining gate |
| --- | --- | --- |
| TRA-SEL-001 | SOURCE+ACTIVATION | `domain.test.ts` proves recommendation read does not create a session; `workspace/AGENTS.md` requires preview before start. Live conversation remains. |
| TRA-SEL-002 | SOURCE-QUALIFIED | `domain.test.ts` proves accepting the recommendation creates exactly one session. |
| TRA-SEL-003 | SOURCE+ACTIVATION | Forward override is deterministic in `domain.ts`; `domain.test.ts` proves cursor stays put until completion. User-language selection remains behavioral. |
| TRA-SEL-004 | SOURCE-QUALIFIED | Forward completion records intervening `SKIPPED_FORWARD_OVERRIDE` outcomes and advances to the slot after the selected one. |
| TRA-SEL-005 | SOURCE-QUALIFIED | Repeat of an earlier slot leaves cursor and original slot outcome intact. |
| TRA-SEL-006 | SOURCE+ACTIVATION | Ad-hoc start/finish leaves cursor unchanged; workspace owns recognition of explicit ad-hoc intent. |
| TRA-SEL-007 | SOURCE-QUALIFIED | Duplicate Conditioning template selection resolves deterministically to the nearest not-yet-passed matching slot and fails closed when none remains. |
| TRA-SEL-008 | SOURCE+ACTIVATION | `training_program_cycle_restart` starts a new cycle at Strength A and preserves prior history; recognizing explicit restart intent remains behavioral. |
| TRA-SEL-009 | SOURCE+ACTIVATION | An open PAUSED session prevents a second session; workspace requires surfacing/resuming durable state. |

## Program versioning and authority

| ID | Status | Evidence / remaining gate |
| --- | --- | --- |
| TRA-PROG-001 | SOURCE+ACTIVATION | Proposal creation is bounded and leaves the active Program Version unchanged; identifying when to propose remains model-mediated. |
| TRA-PROG-002 | SOURCE-QUALIFIED | Exact proposal application creates a new immutable Program Version and retires the old version. |
| TRA-PROG-003 | SOURCE+ACTIVATION | Workspace defines direct unambiguous user instruction as approval with no redundant confirmation; deterministic apply path remains proposal-bound and owner-scoped. Live conversation remains. |
| TRA-PROG-004 | SOURCE-QUALIFIED | New active Program Version receives cycle 1 cursor at Strength A. |
| TRA-PROG-005 | SOURCE-QUALIFIED | Apply operation rejects version changes while ACTIVE or PAUSED session exists. |
| TRA-PROG-006 | SOURCE+ACTIVATION | No arbitrary program-mutation tool exists; apply is exact-proposal-only, owner-scoped, current-invocation guarded, stale-base guarded. Effective live forbidden paths remain an activation check. |

## Strength prescription and execution

| ID | Status | Evidence / remaining gate |
| --- | --- | --- |
| TRA-STR-001 | SOURCE-QUALIFIED | Final working-set prescription is persisted before later completion and cannot be silently replaced. |
| TRA-STR-002 | SOURCE-QUALIFIED | `domain.test.ts` closes/reopens SQLite and proves the exact persisted prescription survives and replays unchanged; recovery qualification additionally restores durable session state. |
| TRA-STR-003 | SOURCE+ACTIVATION | `AS_PRESCRIBED` deterministically copies all targets to actuals; workspace defines Russian `готово` semantics. |
| TRA-STR-004 | SOURCE+ACTIVATION | Explicit actual sets are validated atomically; natural-language parsing remains model-mediated. |
| TRA-STR-005 | BEHAVIORAL-ACTIVATION | Workspace requires minimum clarification for material ambiguity and forbids guessing. |
| TRA-STR-006 | SOURCE+ACTIVATION | DEFERRED transition is deterministic; mapping `дальше` / busy-equipment language remains behavioral. |
| TRA-STR-007 | SOURCE+ACTIVATION | Deferred exercise can be resumed with its durable prescription intact; workspace requires returning to deferred work later. |
| TRA-STR-008 | SOURCE+ACTIVATION | Skip deterministically marks remaining planned sets SKIPPED; interpreting `пропустить` remains behavioral. |
| TRA-STR-009 | SOURCE+ACTIVATION | Session-only substitution preserves canonical original exercise and does not mutate the Program Version; natural-language request remains behavioral. |
| TRA-STR-010 | SOURCE-QUALIFIED | No warm-up-set operational model exists; workspace explicitly forbids requesting, inferring, or recording warm-up sets. |

## Exercise semantics and validation

| ID | Status | Evidence / remaining gate |
| --- | --- | --- |
| TRA-VAL-001 | SOURCE-QUALIFIED | Exercise catalog preserves `PER_HAND` load semantics without converting displayed per-hand load to total load. |
| TRA-VAL-002 | SOURCE-QUALIFIED | Assistance exercise test proves `LOWER_IS_HARDER` progression decreases displayed assistance after success streak. |
| TRA-VAL-003 | SOURCE-QUALIFIED | Exercise catalog preserves `PER_SIDE` repetition semantics. |
| TRA-VAL-004 | SOURCE-QUALIFIED | Progression history filters by equipment instance; test proves another machine instance is not treated as comparable. |
| TRA-VAL-005 | SOURCE-QUALIFIED | Structurally invalid actuals fail before any set mutation commits. |
| TRA-VAL-006 | SOURCE+ACTIVATION | 700-vs-70 anomaly fails atomically as SUSPICIOUS; workspace requires minimal user confirmation rather than silent correction. |
| TRA-VAL-007 | SOURCE+ACTIVATION | Corrected retry persists once after suspicious attempt left no mutation; interpreting the confirmation remains behavioral. |
| TRA-VAL-008 | SOURCE-QUALIFIED | Correction operation updates authoritative value and records before/after/reason audit evidence. |

## Session lifecycle and integrity

| ID | Status | Evidence / remaining gate |
| --- | --- | --- |
| TRA-LIFE-001 | SOURCE-QUALIFIED | PAUSED state and pause interval persist without cursor movement. |
| TRA-LIFE-002 | SOURCE+PRODUCTION | Local resume and synthetic recovery prove durable PAUSED state including open pause interval; production restore remains an activation gate. |
| TRA-LIFE-003 | SOURCE-QUALIFIED | Intentional completion resolves remaining work as skipped and applies completed-session cursor effect. |
| TRA-LIFE-004 | SOURCE-QUALIFIED | ABANDONED closes unresolved work while preserving completed work and leaves cursor unchanged. |
| TRA-LIFE-005 | SOURCE-QUALIFIED | VOIDED session releases open-session constraint, is excluded from progression, and cannot generate learning observations/evidence. |
| TRA-LIFE-006 | SOURCE-QUALIFIED | Qualified OpenClaw persistently deduplicates Telegram source messages; Training atomically receipts successful mutation by tool-call id + operation + input hash. |
| TRA-LIFE-007 | SOURCE-QUALIFIED | Tool-call receipt key includes operation name, so distinct operations do not collide; same operation/input replays prior result and mismatched input fails closed. |
| TRA-LIFE-008 | SOURCE+ACTIVATION | Workspace requires durable-state inspection after disconnect/ambiguous outcome; layered idempotency prevents duplicate mutation. Live disconnect behavior remains an activation test. |

## Conditioning

| ID | Status | Evidence / remaining gate |
| --- | --- | --- |
| TRA-CON-001 | BEHAVIORAL-ACTIVATION | Workspace requires modality recommendation plus complete modality-appropriate protocol; deterministic policy/modalities are exposed by Training state. |
| TRA-CON-002 | SOURCE+ACTIVATION | User modality override remains in the same Conditioning session/slot and stores a modality-specific prescription; conversational override remains behavioral. |
| TRA-CON-003 | SOURCE-QUALIFIED | Test verifies recommended modality and selected modality are both persisted correctly. |
| TRA-CON-004 | BEHAVIORAL-ACTIVATION | Workspace requires presenting interval protocol upfront rather than turn-by-turn interval control. |
| TRA-CON-005 | SOURCE-QUALIFIED | Conditioning completes with no external telemetry link; Fitbit absence is non-blocking. |
| TRA-CON-006 | DEFERRED-FITBIT | Training schema has session-linked aggregate/reference boundary; actual attachment is qualified only when Fitbit integration is implemented. |
| TRA-CON-007 | DEFERRED-FITBIT | Workspace and canonical architecture forbid raw Fitbit sample storage in Training; enforcement across Fitbit integration is qualified with that future dependency. |

## Feedback and training-domain learning

| ID | Status | Evidence / remaining gate |
| --- | --- | --- |
| TRA-LRN-001 | SOURCE+ACTIVATION | Bounded feedback and observation operations exist with provenance; deciding what feedback is useful remains model-mediated. |
| TRA-LRN-002 | SOURCE+ACTIVATION | Deterministic learning rules prevent situational user evidence from promoting ACTIVE learning; classification of the phrase remains behavioral. |
| TRA-LRN-003 | SOURCE+ACTIVATION | Explicitly persistent USER_CHAT evidence can create ACTIVE learning with provenance. |
| TRA-LRN-004 | SOURCE+ACTIVATION | PERFORMANCE evidence may create HYPOTHESIS but cannot self-promote ACTIVE; pattern extraction remains behavioral. |
| TRA-LRN-005 | SOURCE-QUALIFIED | Contradictory evidence is retained and test proves prior ACTIVE item can become SUPERSEDED with contradiction provenance. |
| TRA-LRN-006 | SOURCE-QUALIFIED | AGENT_ANALYSIS evidence alone cannot promote ACTIVE learning. |
| TRA-LRN-007 | SOURCE+ACTIVATION | Learning cannot mutate program directly; bounded proposal/apply path is separate. Deciding when learning justifies a proposal remains behavioral. |
| TRA-LRN-008 | BEHAVIORAL-ACTIVATION | Workspace explicitly routes reusable agent/system improvement evidence to the ADR-007 path and forbids disguising it as Training learning. |

## Medical and authority boundary

| ID | Status | Evidence / remaining gate |
| --- | --- | --- |
| TRA-BND-001 | BEHAVIORAL-ACTIVATION | Workspace requires conservative handling of material acute problems and forbids pushing through concerning pain. |
| TRA-BND-002 | SOURCE+ACTIVATION | Bounded feedback/observation path exists without a persistent medical/safety-flag model; classification remains behavioral. |
| TRA-BND-003 | BEHAVIORAL-ACTIVATION | Workspace forbids diagnosis/treatment/rehabilitation and requires appropriate health/medical escalation for persistent or worsening symptoms. |
| TRA-BND-004 | SOURCE+ACTIVATION | Plugin tests prove non-owner/other-agent tools do not instantiate; tool policy denies generic file/shell/Gateway/cross-session paths. Effective production tool surface remains an activation check. |

## Migration, recovery, and activation

| ID | Status | Evidence / remaining gate |
| --- | --- | --- |
| TRA-MIG-001 | SOURCE+PRODUCTION | Synthetic normalized strength migration preserves reps/load/RIR/duration/distance, including incomplete load-only historical completed sets, and date-only precision; private Fitness export remains production work. |
| TRA-MIG-002 | SOURCE+PRODUCTION | Synthetic Conditioning migration preserves method, modality, duration, distance, RPE, notes, and aggregate average HR; average HR is stored as aggregate-only telemetry provenance without inventing raw samples. Private Fitness export remains production work. |
| TRA-MIG-003 | SOURCE+PRODUCTION | Importer is replay-safe and SQLite integrity/FK checks pass; representative real records must reconcile against the private Fitness source before activation. |
| TRA-REC-001 | SOURCE+PRODUCTION | Synthetic provider-independent encrypted backup/restore path passes, including corruption and FK fail-closed behavior; actual protected-provider restore remains a production gate. |
| TRA-REC-002 | SOURCE+PRODUCTION | Synthetic restore verifies Program Version, cursor, and PAUSED session with open pause interval; actual recovery point restore remains a production gate. |
| TRA-REC-003 | PRODUCTION-GATE | Fitness remains authoritative until an actual recovery exercise succeeds; source implementation alone cannot satisfy this gate. |
| TRA-ACT-001 | PRODUCTION-GATE | Frozen stage-only deployment/rollback is source-qualified and live read-only preflight reports Training ABSENT. Activation still requires private migration/reconciliation, protected backup/restore, model/authentication, owner-only route, effective tool checks, and live conversational validation. |
| TRA-ACT-002 | PRODUCTION-GATE | Requires explicit operational activation plus Nexus/runtime source-registration reconciliation; Fitness must not remain a competing active training authority. |

## Migration-source regression: Conditioning mobility blocks

The authoritative pre-cutover Fitness cycle states that each between-strength Conditioning session includes its applicable mobility block while retaining the existing exercise selection. Historical Fitness rows recorded as a same-date Conditioning summary plus Mobility A/B working sets are normalized into one migrated `CONDITIONING` session so completed mobility work is not lost. Training therefore supports planned `template_exercises` on `CONDITIONING` templates. The two program positions use distinct `Conditioning A` / `Conditioning B` templates so Mobility A and Mobility B remain distinct, while generic user selection of “Conditioning” resolves deterministically to the nearest not-yet-passed Conditioning slot by workout kind. This regression is qualified in the domain and normalized-migration test suites.

## Source-freeze conclusion

At source freeze:

- there must be no **GAP** status
- **DEFERRED-FITBIT** rows do not block Training Agent v1 because Fitbit integration is explicitly outside v1 activation scope
- **BEHAVIORAL-ACTIVATION** rows follow the Nexus rule that normal model-mediated behavior is validated through ordinary/live use rather than a standing pre-production model-qualification harness
- **SOURCE+PRODUCTION** and **PRODUCTION-GATE** rows block operational activation until their live evidence exists
- merge of the implementation source does not itself activate the Training Agent or change the authoritative training source
