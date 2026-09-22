import type { CalendarConfig } from "./core.js";

export const VALID_CONFIG: CalendarConfig = {
  designatedCalendar: "primary",
  providerTools: {
    prefix: "calendar_provider_",
    read: [
      "calendar_provider_list_events",
      "calendar_provider_get_event",
      "calendar_provider_get_labels"
    ],
    classificationWrite: "calendar_provider_set_label"
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
