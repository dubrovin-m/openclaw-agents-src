import "node-fetch";
import { parseCalendarConfig, type CalendarConfig } from "./core.js";
import { getRuleProposal } from "./rules.js";

export const CALENDAR_AGENT_ID = "calendar";
const OWNED_TOOLS = new Set([
  "calendar_config_get",
  "calendar_review_window",
  "calendar_analyze",
  "calendar_rule_propose",
]);
const CALENDAR_ONLY_OWNED_TOOLS = new Set([
  "calendar_rule_propose",
  "calendar_rule_commit",
]);
const EVENT_REFERENCE_PATTERN = /^evt_[0-9]{8}_[0-9a-f]{16}$/u;
const RULE_PROPOSAL_PATTERN = /^proposal_[0-9a-f]{16}$/u;

type ToolEvent = { toolName?: string; params?: Record<string, unknown> };
type ToolContext = { agentId?: string };

function block(reason: string) {
  return { block: true, blockReason: reason };
}
function baseCalendarConfig(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const { durableRules: _durableRules, ...base } = value as Record<string, unknown>;
  return base;
}
function writeAllowed(config: CalendarConfig, params: Record<string, unknown> | undefined) {
  if (!params || Object.keys(params).sort().join(",") !== "event_id,expected_label_id,label_id,write_mode") {
    return block("Calendar classification write accepts exactly event_id, label_id, expected_label_id, and write_mode.");
  }
  if (typeof params.event_id !== "string" || !EVENT_REFERENCE_PATTERN.test(params.event_id)) {
    return block("Calendar classification write requires one deterministic Calendar event reference.");
  }
  if (typeof params.label_id !== "string" || params.label_id.trim().length === 0 || params.label_id.length > 1024) {
    return block("Calendar classification write requires one bounded label_id.");
  }
  const categoryLabels = new Set(config.leaves.map((leaf) => leaf.providerLabel.id));
  if (!categoryLabels.has(params.label_id)) {
    return block("Calendar classification write label_id is not part of the effective analytical configuration.");
  }
  const expected = params.expected_label_id;
  if (expected !== null && (typeof expected !== "string" || expected.trim().length === 0 || expected.length > 1024)) {
    return block("Calendar classification write expected_label_id must be null or one bounded configured analytical label.");
  }
  const expectedLabels = new Set([...categoryLabels, config.unclassifiedLabel.id]);
  if (typeof expected === "string" && !expectedLabels.has(expected)) {
    return block("Calendar classification write expected_label_id is not part of the effective analytical configuration.");
  }
  if (params.write_mode !== "automatic" && params.write_mode !== "human_correction") {
    return block("Calendar classification write requires write_mode automatic or human_correction.");
  }
  if (params.write_mode === "automatic" && expected !== null && expected !== config.unclassifiedLabel.id) {
    return block("Automatic Calendar classification may start only from no label or technical Unclassified.");
  }
  return undefined;
}

export function calendarToolPolicy(
  configValue: unknown,
  event: ToolEvent,
  context: ToolContext,
) {
  const config = parseCalendarConfig(baseCalendarConfig(configValue));
  const toolName = event.toolName ?? "";
  const isNativeCalendarTool = toolName.startsWith(config.providerTools.prefix);

  if (context.agentId !== CALENDAR_AGENT_ID) {
    return isNativeCalendarTool || CALENDAR_ONLY_OWNED_TOOLS.has(toolName)
      ? block("Calendar provider and durable-rule tools are restricted to the Calendar Agent.")
      : undefined;
  }

  if (toolName === "calendar_rule_commit") {
    if (!event.params || Object.keys(event.params).join(",") !== "proposal_id"
      || typeof event.params.proposal_id !== "string"
      || !RULE_PROPOSAL_PATTERN.test(event.params.proposal_id)) {
      return block("Calendar rule commit accepts exactly one valid proposal_id.");
    }
    const proposal = getRuleProposal(event.params.proposal_id);
    if (!proposal) return block("Calendar rule proposal is unknown or expired; create a fresh proposal.");
    return {
      requireApproval: {
        title: "Сохранить правило Calendar",
        description: proposal.summary,
        severity: "warning" as const,
        timeoutMs: 120_000,
        timeoutReason: "Calendar rule was not approved in time.",
        allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "deny">,
      },
    };
  }
  if (OWNED_TOOLS.has(toolName)) return undefined;
  if (config.providerTools.read.includes(toolName)) return undefined;
  if (toolName === config.providerTools.classificationWrite) return writeAllowed(config, event.params);
  if (toolName === config.providerTools.labelAdminWrite) {
    if (event.params && Object.keys(event.params).length > 0) {
      return block("Calendar label-definition sync accepts no model-supplied mutation payload.");
    }
    return undefined;
  }

  return block("Tool is outside the Calendar Agent authority boundary.");
}
