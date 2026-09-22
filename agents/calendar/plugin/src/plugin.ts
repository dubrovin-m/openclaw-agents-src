import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { analyzeCalendar, parseCalendarConfig, reviewWindow } from "./core.js";
import { calendarToolPolicy } from "./policy.js";

const configGetParameters = Type.Object({}, { additionalProperties: false });
const reviewWindowParameters = Type.Object({
  kind: Type.Union([Type.Literal("daily"), Type.Literal("biweekly")]),
  boundary: Type.Optional(Type.String()),
}, { additionalProperties: false });
const eventParameters = Type.Object({
  id: Type.String({ minLength: 1 }),
  start: Type.String({ minLength: 1 }),
  end: Type.String({ minLength: 1 }),
  classification: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
}, { additionalProperties: false });
const analyzeParameters = Type.Object({
  kind: Type.Union([Type.Literal("daily"), Type.Literal("biweekly")]),
  boundary: Type.Optional(Type.String()),
  events: Type.Array(eventParameters),
}, { additionalProperties: false });

const entry = defineToolPlugin({
  id: "calendar-analytics",
  name: "Calendar Analytics",
  description: "Stateless Calendar Agent configuration, deterministic analytics, and fail-closed tool policy.",
  tools: (tool) => [
    tool({
      name: "calendar_config_get",
      label: "Calendar configuration",
      description: "Read the effective validated operational Calendar taxonomy, targets, provider labels, and native-tool identities.",
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
  ],
});

const registerTools = entry.register;
entry.register = (api) => {
  parseCalendarConfig(api.pluginConfig);
  registerTools(api);
  api.on("before_tool_call", (event, context) => calendarToolPolicy(api.pluginConfig, event, context), { priority: 100 });
};

export default entry;
