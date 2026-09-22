import type { CalendarConfig } from "./core.js";

export const VALID_CONFIG: CalendarConfig = {
  designatedCalendar: "primary",
  nativeTools: {
    prefix: "mcp__codex_apps__google_calendar_",
    read: [
      "mcp__codex_apps__google_calendar_search",
      "mcp__codex_apps__google_calendar_read_event",
      "mcp__codex_apps__google_calendar_list_event_labels"
    ],
    classificationWrite: "mcp__codex_apps__google_calendar_set_event_label_silently"
  },
  parents: [
    { id: "direction", name: "Direction" },
    { id: "execution", name: "Execution" }
  ],
  leaves: [
    {
      id: "strategy",
      name: "Strategy",
      kind: "management",
      parentId: "direction",
      providerLabel: { id: "label-strategy", name: "Strategy", backgroundColor: "#336699" }
    },
    {
      id: "delivery",
      name: "Delivery",
      kind: "management",
      parentId: "execution",
      providerLabel: { id: "label-delivery", name: "Delivery", backgroundColor: "#669933" }
    },
    {
      id: "service",
      name: "Service",
      kind: "service",
      providerLabel: { id: "label-service", name: "Service", backgroundColor: "#999999" }
    }
  ],
  unclassifiedLabel: { id: "label-unclassified", name: "Unclassified", backgroundColor: "#CCCCCC" },
  targets: {
    parents: { direction: 60, execution: 40 },
    leaves: { strategy: 60, delivery: 40 }
  }
};
