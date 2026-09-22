import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { analyzeCalendar, parseCalendarConfig, reviewWindow } from "./core.js";
import { calendarToolPolicy } from "./policy.js";
import { createGoogleCalendarProvider } from "./provider.js";

const providerLabelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  backgroundColor: Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }),
}, { additionalProperties: false });

const calendarConfigSchema = Type.Object({
  designatedCalendar: Type.String({ minLength: 1 }),
  providerTools: Type.Object({
    prefix: Type.String({ minLength: 1 }),
    read: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
    classificationWrite: Type.String({ minLength: 1 }),
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
  }, { additionalProperties: false }), { minItems: 1 }),
  unclassifiedLabel: providerLabelSchema,
  targets: Type.Object({
    parents: Type.Record(Type.String({ minLength: 1 }), Type.Number({ minimum: 0, maximum: 100 })),
    leaves: Type.Record(Type.String({ minLength: 1 }), Type.Number({ minimum: 0, maximum: 100 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const configGetParameters = Type.Object({}, { additionalProperties: false });
const reviewWindowParameters = Type.Object({
  kind: Type.Union([Type.Literal("daily"), Type.Literal("biweekly")]),
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
const providerEventParameters = Type.Object({
  event_id: Type.String({ minLength: 1, maxLength: 1024 }),
}, { additionalProperties: false });
const providerSetLabelParameters = Type.Object({
  event_id: Type.String({ minLength: 1, maxLength: 1024 }),
  label_id: Type.String({ minLength: 1, maxLength: 1024 }),
}, { additionalProperties: false });

const provider = createGoogleCalendarProvider();

const entry = defineToolPlugin({
  id: "calendar-analytics",
  name: "Calendar Analytics",
  description: "Stateless Calendar Agent configuration, deterministic analytics, and fail-closed tool policy.",
  configSchema: calendarConfigSchema,
  tools: (tool) => [
    tool({
      name: "calendar_config_get",
      label: "Calendar configuration",
      description: "Read the effective validated operational Calendar taxonomy, targets, provider labels, and provider-tool identities.",
      parameters: configGetParameters,
      optional: true,
      execute: async (_params, config) => parseCalendarConfig(config),
    }),
    tool({
      name: "calendar_review_window",
      label: "Calendar review window",
      description: "Resolve the canonical Daily or Biweekly Calendar analysis window in Europe/Moscow.",
      parameters: reviewWindowParameters,
      optional: true,
      execute: async (params) => reviewWindow(params.kind, params.boundary),
    }),
    tool({
      name: "calendar_analyze",
      label: "Calendar deterministic analysis",
      description: "Calculate non-duplicated scheduled load, management/service/free time, classification coverage, and target allocation.",
      parameters: analyzeParameters,
      optional: true,
      execute: async (params, config) => analyzeCalendar(config, params.kind, params.boundary, params.events),
    }),
    tool({
      name: "calendar_provider_list_events",
      label: "Calendar events",
      description: "Read events from the designated Google Calendar within one bounded RFC3339 time window.",
      parameters: providerListParameters,
      optional: true,
      execute: async (params, config) => provider.listEvents(config, params),
    }),
    tool({
      name: "calendar_provider_get_event",
      label: "Calendar event",
      description: "Read one event from the designated Google Calendar by event id.",
      parameters: providerEventParameters,
      optional: true,
      execute: async (params, config) => provider.getEvent(config, params),
    }),
    tool({
      name: "calendar_provider_get_labels",
      label: "Calendar labels",
      description: "Read custom event labels from the designated Google Calendar.",
      parameters: configGetParameters,
      optional: true,
      execute: async (_params, config) => provider.getLabels(config),
    }),
    tool({
      name: "calendar_provider_set_label",
      label: "Set Calendar analytical label",
      description: "Assign one configured analytical event label without changing title, time, attendees, RSVP, description, or sending guest updates.",
      parameters: providerSetLabelParameters,
      optional: true,
      execute: async (params, config) => provider.setLabel(config, params),
    }),
  ],
});

const registerTools = entry.register;
entry.register = (api) => {
  parseCalendarConfig(api.pluginConfig);
  registerTools(api);
  api.on("before_tool_call", (event, context) => calendarToolPolicy(api.pluginConfig, event, context), { priority: 100 });
};

export default entry;
