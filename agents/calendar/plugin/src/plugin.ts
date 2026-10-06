import { Type, type Static, type TSchema } from "typebox";
import {
  defineToolPlugin,
  type ToolPluginExecutionContext,
  type ToolPluginToolDefinition,
} from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult, textResult } from "openclaw/plugin-sdk/tool-results";
import { analyzeCalendar, parseCalendarConfig, reviewWindow } from "./core.js";
import { calendarToolPolicy } from "./policy.js";
import { createGoogleCalendarProvider } from "./provider.js";
import {
  applyRuleProposal,
  getRuleProposal,
  MAX_RULE_PROPOSALS,
  parseDurableRules,
  parseStoredRuleProposals,
  proposeRule,
  RULE_PROPOSAL_TTL_MS,
  type DurableRules,
  type RuleProposalInput,
  type RuleProposalStore,
  type StoredRuleProposal,
} from "./rules.js";

const providerLabelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  backgroundColor: Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
}, { additionalProperties: false });

const durableClassificationRuleSchema = Type.Object({
  id: Type.String({ minLength: 3, maxLength: 64, pattern: "^[a-z][a-z0-9_-]{2,63}$" }),
  condition: Type.String({ minLength: 1, maxLength: 320 }),
  categoryId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const durableHygieneRuleSchema = Type.Object({
  id: Type.String({ minLength: 3, maxLength: 64, pattern: "^[a-z][a-z0-9_-]{2,63}$" }),
  condition: Type.String({ minLength: 1, maxLength: 320 }),
  requireLeader: Type.Boolean(),
  requireAgenda: Type.Boolean(),
}, { additionalProperties: false });

const durableRulesSchema = Type.Object({
  classification: Type.Array(durableClassificationRuleSchema),
  hygiene: Type.Array(durableHygieneRuleSchema),
}, { additionalProperties: false });

const calendarConfigSchema = Type.Object({
  designatedCalendar: Type.String({ minLength: 1 }),
  providerTools: Type.Object({
    prefix: Type.String({ minLength: 1 }),
    read: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
    classificationWrite: Type.String({ minLength: 1 }),
    labelAdminWrite: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  parents: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), { minItems: 1 }),
  leaves: Type.Array(Type.Object({
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("management"), Type.Literal("service")]),
    parentId: Type.Optional(Type.String({ minLength: 1 })),
    providerLabel: providerLabelSchema,
    definition: Type.String({ minLength: 1 }),
    includes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
    excludes: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    examples: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }), { minItems: 1 }),
  unclassifiedLabel: providerLabelSchema,
  classificationRules: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  durableRules: Type.Optional(durableRulesSchema),
  pendingRuleProposals: Type.Optional(Type.Array(Type.Object({
    proposalId: Type.String({ pattern: "^proposal_[0-9a-f]{16}$" }),
    action: Type.Union([Type.Literal("create"), Type.Literal("replace"), Type.Literal("delete")]),
    kind: Type.Union([Type.Literal("classification"), Type.Literal("hygiene_exception")]),
    targetDigest: Type.Optional(Type.String({ pattern: "^[0-9a-f]{32}$" })),
    rule: Type.Optional(Type.Union([durableClassificationRuleSchema, durableHygieneRuleSchema])),
    ruleId: Type.Optional(Type.String({ minLength: 3, maxLength: 64, pattern: "^[a-z][a-z0-9_-]{2,63}$" })),
    summary: Type.String({ minLength: 1, maxLength: 512 }),
    createdAt: Type.Number({ minimum: 1 }),
  }, { additionalProperties: false }), { maxItems: MAX_RULE_PROPOSALS })),
  targets: Type.Object({
    parents: Type.Record(Type.String({ minLength: 1 }), Type.Number({ minimum: 0, maximum: 100 })),
    leaves: Type.Record(Type.String({ minLength: 1 }), Type.Number({ minimum: 0, maximum: 100 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const configGetParameters = Type.Object({}, { additionalProperties: false });
const reviewWindowParameters = Type.Object({
  kind: Type.Union([Type.Literal("daily"), Type.Literal("next_workday"), Type.Literal("biweekly")]),
  boundary: Type.Optional(Type.String()),
}, { additionalProperties: false });
const eventParameters = Type.Object({
  id: Type.String({ minLength: 1 }),
  start: Type.String({ minLength: 1 }),
  end: Type.String({ minLength: 1 }),
  allDay: Type.Optional(Type.Boolean()),
  classification: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
}, { additionalProperties: false });
const analyzeParameters = Type.Object({
  kind: Type.Union([Type.Literal("daily"), Type.Literal("biweekly")]),
  boundary: Type.Optional(Type.String()),
  events: Type.Array(eventParameters),
}, { additionalProperties: false });
const providerListParameters = Type.Object({
  time_min: Type.String({ minLength: 1 }),
  time_max: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const eventReferenceSchema = Type.String({
  minLength: 29,
  maxLength: 29,
  pattern: "^evt_[0-9]{8}_[0-9a-f]{16}$",
});
const providerEventParameters = Type.Object({
  event_id: eventReferenceSchema,
}, { additionalProperties: false });
const providerSetLabelParameters = Type.Object({
  event_id: eventReferenceSchema,
  label_id: Type.String({ minLength: 1, maxLength: 1024 }),
  expected_label_id: Type.Union([Type.String({ minLength: 1, maxLength: 1024 }), Type.Null()]),
  write_mode: Type.Union([Type.Literal("automatic"), Type.Literal("human_correction")]),
}, { additionalProperties: false });
const ruleProposalParameters = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("replace"), Type.Literal("delete")]),
  kind: Type.Union([Type.Literal("classification"), Type.Literal("hygiene_exception")]),
  rule_id: Type.Optional(Type.String({ minLength: 3, maxLength: 64, pattern: "^[a-z][a-z0-9_-]{2,63}$" })),
  condition: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  category_id: Type.Optional(Type.String({ minLength: 1 })),
  require_leader: Type.Optional(Type.Boolean()),
  require_agenda: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const ruleCommitParameters = Type.Object({
  proposal_id: Type.String({ pattern: "^proposal_[0-9a-f]{16}$" }),
}, { additionalProperties: false });

type MutableConfigRoot = {
  plugins?: {
    entries?: Record<string, { config?: Record<string, unknown> }>;
  };
};

type EffectiveCalendarConfig = ReturnType<typeof parseCalendarConfig> & { durableRules: DurableRules };
type CalendarPluginConfig = Static<typeof calendarConfigSchema>;
type CalendarPluginApi = ToolPluginExecutionContext["api"];

function proposalIsLive(proposal: StoredRuleProposal, now = Date.now()) {
  return proposal.createdAt <= now && now - proposal.createdAt < RULE_PROPOSAL_TTL_MS;
}

function pluginConfigFromRoot(root: unknown): Record<string, unknown> {
  const mutable = root as MutableConfigRoot;
  const config = mutable.plugins?.entries?.["calendar-analytics"]?.config;
  if (!config) throw new Error("Calendar plugin configuration is unavailable");
  return config;
}

export function ruleProposalStore(api: CalendarPluginApi): RuleProposalStore {
  return {
    async register(key, value, opts) {
      if (key !== value.proposalId) throw new Error("Calendar proposal key does not match proposal identity");
      if (opts?.ttlMs !== undefined && opts.ttlMs !== RULE_PROPOSAL_TTL_MS) {
        throw new Error("Calendar proposal TTL is fixed by the implementation contract");
      }
      const mutation = await api.runtime.config.mutateConfigFile<void>({
        afterWrite: { mode: "auto" },
        mutate(draft) {
          const pluginEntry = (draft as unknown as MutableConfigRoot).plugins?.entries?.["calendar-analytics"];
          if (!pluginEntry?.config) throw new Error("Calendar plugin configuration is unavailable");
          const current = operationalConfig(pluginEntry.config);
          const now = Date.now();
          const pending = current.pendingRuleProposals
            .filter((proposal) => proposalIsLive(proposal, now) && proposal.proposalId !== key);
          pending.push(structuredClone(value));
          pending.sort((left, right) => left.createdAt - right.createdAt || left.proposalId.localeCompare(right.proposalId));
          const bounded = pending.slice(-MAX_RULE_PROPOSALS);
          const { pendingRuleProposals: _oldPending, ...rest } = pluginEntry.config;
          const nextConfig = { ...rest, ...(bounded.length > 0 ? { pendingRuleProposals: bounded } : {}) };
          operationalConfig(nextConfig);
          pluginEntry.config = nextConfig;
        },
      });
      void mutation;
    },
    async lookup(key) {
      const current = operationalConfig(pluginConfigFromRoot(api.runtime.config.current()));
      const proposal = current.pendingRuleProposals.find((item) => item.proposalId === key);
      return proposal && proposalIsLive(proposal) ? structuredClone(proposal) : undefined;
    },
    async delete(key) {
      const mutation = await api.runtime.config.mutateConfigFile<{ deleted: boolean }>({
        afterWrite: { mode: "auto" },
        mutate(draft) {
          const pluginEntry = (draft as unknown as MutableConfigRoot).plugins?.entries?.["calendar-analytics"];
          if (!pluginEntry?.config) throw new Error("Calendar plugin configuration is unavailable");
          const current = operationalConfig(pluginEntry.config);
          const now = Date.now();
          const deleted = current.pendingRuleProposals.some((proposal) => proposal.proposalId === key && proposalIsLive(proposal, now));
          const pending = current.pendingRuleProposals
            .filter((proposal) => proposal.proposalId !== key && proposalIsLive(proposal, now));
          const { pendingRuleProposals: _oldPending, ...rest } = pluginEntry.config;
          const nextConfig = { ...rest, ...(pending.length > 0 ? { pendingRuleProposals: pending } : {}) };
          operationalConfig(nextConfig);
          pluginEntry.config = nextConfig;
          return { deleted };
        },
      });
      return mutation.result?.deleted ?? false;
    },
  };
}

type DirectOnlyToolSpec<TParamsSchema extends TSchema> = {
  name: string;
  label?: string;
  description: string;
  parameters: TParamsSchema;
  optional?: boolean;
  execute: (
    params: Static<TParamsSchema>,
    config: CalendarPluginConfig,
    context: ToolPluginExecutionContext,
  ) => unknown;
};

function wrapToolResult(result: unknown) {
  return typeof result === "string" ? textResult(result, result) : jsonResult(result);
}

function directOnlyTool<TParamsSchema extends TSchema>(
  definition: DirectOnlyToolSpec<TParamsSchema>,
): ToolPluginToolDefinition<CalendarPluginConfig, TParamsSchema> {
  const { execute, ...metadata } = definition;
  return {
    ...metadata,
    factory: ({ api, config }) => ({
      name: metadata.name,
      label: metadata.label ?? metadata.name,
      description: metadata.description,
      parameters: metadata.parameters,
      catalogMode: "direct-only",
      async execute(toolCallId, params, signal, onUpdate) {
        return wrapToolResult(
          await execute(params as Static<TParamsSchema>, config, {
            api,
            signal,
            toolCallId,
            onUpdate,
          }),
        );
      },
    }),
  };
}

function operationalConfig(value: unknown): {
  baseValue: Record<string, unknown>;
  effective: EffectiveCalendarConfig;
  pendingRuleProposals: StoredRuleProposal[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Calendar configuration must be an object");
  }
  const {
    durableRules: durableRulesValue,
    pendingRuleProposals: pendingRuleProposalsValue,
    ...baseValue
  } = value as Record<string, unknown>;
  const base = parseCalendarConfig(baseValue);
  const durableRules = parseDurableRules(durableRulesValue);
  const pendingRuleProposals = parseStoredRuleProposals(pendingRuleProposalsValue);
  const leafIds = new Set(base.leaves.map((leaf) => leaf.id));
  for (const rule of durableRules.classification) {
    if (!leafIds.has(rule.categoryId)) {
      throw new Error(`durable classification rule ${rule.id} references an unknown category`);
    }
  }
  return { baseValue, effective: { ...base, durableRules }, pendingRuleProposals };
}

const provider = createGoogleCalendarProvider();

const entry = defineToolPlugin({
  id: "calendar-analytics",
  name: "Calendar Analytics",
  description: "Calendar Agent operational configuration, deterministic analytics, and fail-closed tool policy.",
  configSchema: calendarConfigSchema,
  tools: (tool) => [
    tool(directOnlyTool({
      name: "calendar_config_get",
      label: "Calendar configuration",
      description: "Read the effective validated operational Calendar taxonomy, durable rules, classification guidance, targets, provider labels, and provider-tool identities.",
      parameters: configGetParameters,
      optional: true,
      execute: async (_params, config) => operationalConfig(config).effective,
    })),
    tool(directOnlyTool({
      name: "calendar_rule_propose",
      label: "Propose Calendar durable rule",
      description: "Normalize and stage one bounded Calendar durable-rule proposal without changing effective durable rules.",
      parameters: ruleProposalParameters,
      optional: true,
      execute: async (params, config, context) =>
        proposeRule(operationalConfig(config).effective, params as RuleProposalInput, ruleProposalStore(context.api)),
    })),
    tool(directOnlyTool({
      name: "calendar_rule_commit",
      label: "Commit Calendar durable rule",
      description: "Persist exactly one previously normalized Calendar rule proposal after native explicit human approval; accepts only its opaque proposal_id.",
      parameters: ruleCommitParameters,
      optional: true,
      execute: async (params, _config, context) => {
        const store = ruleProposalStore(context.api);
        const proposal = await getRuleProposal(params.proposal_id, store);
        if (!proposal) throw new Error("Calendar rule proposal is unknown or expired; create a fresh proposal");
        const mutation = await context.api.runtime.config.mutateConfigFile<{ durableRules: DurableRules }>({
          afterWrite: { mode: "auto" },
          mutate(draft) {
            const mutable = draft as unknown as MutableConfigRoot;
            const pluginEntry = mutable.plugins?.entries?.["calendar-analytics"];
            if (!pluginEntry?.config) throw new Error("Calendar plugin configuration is unavailable");
            const current = operationalConfig(pluginEntry.config);
            const now = Date.now();
            const stored = current.pendingRuleProposals.find((item) => item.proposalId === params.proposal_id);
            if (!stored || !proposalIsLive(stored, now) || JSON.stringify(stored) !== JSON.stringify(proposal)) {
              throw new Error("Calendar rule proposal changed, expired, or disappeared; create a fresh proposal");
            }
            const durableRules = applyRuleProposal(current.effective.durableRules, stored);
            const pending = current.pendingRuleProposals
              .filter((item) => item.proposalId !== params.proposal_id && proposalIsLive(item, now));
            const { pendingRuleProposals: _oldPending, ...rest } = pluginEntry.config;
            const nextConfig = {
              ...rest,
              durableRules,
              ...(pending.length > 0 ? { pendingRuleProposals: pending } : {}),
            };
            operationalConfig(nextConfig);
            pluginEntry.config = nextConfig;
            return { durableRules };
          },
        });
        return {
          applied: true,
          proposal_id: params.proposal_id,
          summary: proposal.summary,
          durableRules: mutation.result?.durableRules,
          followUp: mutation.followUp,
        };
      },
    })),
    tool(directOnlyTool({
      name: "calendar_review_window",
      label: "Calendar review window",
      description: "Resolve the canonical Daily, Next-Workday, or Biweekly Calendar review window in Europe/Moscow.",
      parameters: reviewWindowParameters,
      optional: true,
      execute: async (params) => reviewWindow(params.kind, params.boundary),
    })),
    tool(directOnlyTool({
      name: "calendar_analyze",
      label: "Calendar deterministic analysis",
      description: "Calculate non-duplicated scheduled load, management/service/free time, classification coverage, and target allocation.",
      parameters: analyzeParameters,
      optional: true,
      execute: async (params, config) => analyzeCalendar(operationalConfig(config).baseValue, params.kind, params.boundary, params.events),
    })),
    tool(directOnlyTool({
      name: "calendar_provider_list_events",
      label: "Calendar events",
      description: "Read events from the designated Google Calendar within one bounded RFC3339 time window, including the deterministic configured classification projection for each event.",
      parameters: providerListParameters,
      optional: true,
      execute: async (params, config) => provider.listEvents(operationalConfig(config).baseValue, params),
    })),
    tool(directOnlyTool({
      name: "calendar_provider_get_event",
      label: "Calendar event",
      description: "Read one event from the designated Google Calendar by the deterministic event reference returned by Calendar event reads, including its deterministic configured classification projection.",
      parameters: providerEventParameters,
      optional: true,
      execute: async (params, config) => provider.getEvent(operationalConfig(config).baseValue, params),
    })),
    tool(directOnlyTool({
      name: "calendar_provider_get_labels",
      label: "Calendar labels",
      description: "Read custom event labels from the designated Google Calendar.",
      parameters: configGetParameters,
      optional: true,
      execute: async (_params, config) => provider.getLabels(operationalConfig(config).baseValue),
    })),
    tool(directOnlyTool({
      name: "calendar_provider_sync_labels",
      label: "Sync Calendar analytical labels",
      description: "Synchronize configured analytical label definitions after explicit human approval while preserving unrelated labels and Calendar properties.",
      parameters: configGetParameters,
      optional: true,
      execute: async (_params, config) => provider.syncLabels(operationalConfig(config).baseValue),
    })),
    tool(directOnlyTool({
      name: "calendar_provider_set_label",
      label: "Set Calendar analytical label",
      description: "Set one configured analytical event label with compare-and-set protection. Pass expected_label_id from the latest event read (null when absent). Use write_mode=automatic only for an unlabeled or technical-Unclassified event; use write_mode=human_correction only for an explicit human correction. Concurrent label changes fail closed. The write never changes title, time, attendees, RSVP, description, or sends guest updates.",
      parameters: providerSetLabelParameters,
      optional: true,
      execute: async (params, config) => provider.setLabel(operationalConfig(config).baseValue, params),
    })),
  ],
});

const registerTools = entry.register;
entry.register = (api) => {
  operationalConfig(api.pluginConfig);
  registerTools(api);
  const proposals = ruleProposalStore(api);
  api.on("before_tool_call", (event, context) => calendarToolPolicy(api.pluginConfig, event, context, proposals), { priority: 100 });
};

export default entry;
