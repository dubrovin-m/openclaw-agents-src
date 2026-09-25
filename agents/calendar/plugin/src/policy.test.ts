import { describe, expect, it } from "vitest";
import { calendarToolPolicy } from "./policy.js";
import { VALID_CONFIG } from "./test-fixture.js";

const EVENT_REF = "evt_20260922_0123456789abcdef";

describe("Calendar tool policy", () => {
  it("does not affect unrelated tools for other agents", () => {
    expect(calendarToolPolicy(VALID_CONFIG, { toolName: "task_list", params: {} }, { agentId: "tasks" })).toBeUndefined();
  });

  it("blocks the Google Calendar provider surface for non-Calendar agents", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "calendar_provider_list_events", params: {} },
      { agentId: "main" },
    )).toMatchObject({ block: true });
  });

  it("allows only configured reads for Calendar Agent", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "calendar_provider_list_events", params: {} },
      { agentId: "calendar" },
    )).toBeUndefined();
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "calendar_provider_delete_event", params: { event_id: "x" } },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
  });

  it("allows only a bounded classification-label write", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      {
        toolName: "calendar_provider_set_label",
        params: { event_id: EVENT_REF, label_id: "label-strategy" },
      },
      { agentId: "calendar" },
    )).toBeUndefined();

    expect(calendarToolPolicy(
      VALID_CONFIG,
      {
        toolName: "calendar_provider_set_label",
        params: { event_id: "raw-provider-event-id", label_id: "label-strategy" },
      },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });

    expect(calendarToolPolicy(
      VALID_CONFIG,
      {
        toolName: "calendar_provider_set_label",
        params: { event_id: EVENT_REF, label_id: "label-strategy", title: "mutate me" },
      },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });

    expect(calendarToolPolicy(
      VALID_CONFIG,
      {
        toolName: "calendar_provider_set_label",
        params: { event_id: EVENT_REF, label_id: "unknown-label" },
      },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
  });

  it("allows only payload-free analytical-label synchronization", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "calendar_provider_sync_labels", params: {} },
      { agentId: "calendar" },
    )).toBeUndefined();
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "calendar_provider_sync_labels", params: { title: "nope" } },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
  });

  it("blocks the technical Unclassified label and every other non-category mutation", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      {
        toolName: "calendar_provider_set_label",
        params: { event_id: EVENT_REF, label_id: "label-unclassified" },
      },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "calendar_provider_respond_event", params: { event_id: "event-1" } },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
  });

  it("fails closed on every unrelated Calendar-agent tool", () => {
    expect(calendarToolPolicy(VALID_CONFIG, { toolName: "exec", params: {} }, { agentId: "calendar" }))
      .toMatchObject({ block: true });
  });
});
