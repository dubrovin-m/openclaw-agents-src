import type { CalendarConfig } from "./core.js";

export const VALID_CONFIG: CalendarConfig = {
  designatedCalendar: "primary",
  nativeTools: {
    prefix: "mcp__google_calendar__",
    read: [
      "mcp__google_calendar__search_events",
      "mcp__google_calendar__read_event",
      "mcp__google_calendar__list_event_labels"
    ],
    classificationWrite: "mcp__google_calendar__set_event_label_silently"
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
