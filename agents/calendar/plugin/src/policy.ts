import { parseCalendarConfig, type CalendarConfig } from "./core.js";

export const CALENDAR_AGENT_ID = "calendar";
const OWNED_TOOLS = new Set([
  "read",
  "calendar_config_get",
  "calendar_review_window",
  "calendar_analyze",
]);

type ToolEvent = { toolName?: string; params?: Record<string, unknown> };
type ToolContext = { agentId?: string };

function block(reason: string) {
  return { block: true, blockReason: reason };
}
function writeAllowed(config: CalendarConfig, params: Record<string, unknown> | undefined) {
  if (!params || Object.keys(params).sort().join(",") !== "event_id,label_id") {
    return block("Calendar classification write accepts exactly event_id and label_id.");
  }
  if (typeof params.event_id !== "string" || params.event_id.trim().length === 0 || params.event_id.length > 1024) {
    return block("Calendar classification write requires one bounded event_id.");
  }
  if (typeof params.label_id !== "string" || params.label_id.trim().length === 0 || params.label_id.length > 1024) {
    return block("Calendar classification write requires one bounded label_id.");
  }
  const allowedLabels = new Set([
    ...config.leaves.map((leaf) => leaf.providerLabel.id),
    config.unclassifiedLabel.id,
  ]);
  if (!allowedLabels.has(params.label_id)) {
    return block("Calendar classification write label_id is not part of the effective analytical configuration.");
  }
  return undefined;
}

export function calendarToolPolicy(
  configValue: unknown,
  event: ToolEvent,
  context: ToolContext,
) {
  const config = parseCalendarConfig(configValue);
  const toolName = event.toolName ?? "";
  const isNativeCalendarTool = toolName.startsWith(config.nativeTools.prefix);

  if (context.agentId !== CALENDAR_AGENT_ID) {
    return isNativeCalendarTool
      ? block("Native Google Calendar tools are restricted to the Calendar Agent.")
      : undefined;
  }

  if (OWNED_TOOLS.has(toolName)) return undefined;
  if (config.nativeTools.read.includes(toolName)) return undefined;
  if (toolName === config.nativeTools.classificationWrite) return writeAllowed(config, event.params);

  return block("Tool is outside the Calendar Agent authority boundary.");
}
