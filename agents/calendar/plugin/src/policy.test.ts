import { describe, expect, it } from "vitest";
import { calendarToolPolicy } from "./policy.js";
import { VALID_CONFIG } from "./test-fixture.js";

describe("Calendar tool policy", () => {
  it("does not affect unrelated tools for other agents", () => {
    expect(calendarToolPolicy(VALID_CONFIG, { toolName: "task_list", params: {} }, { agentId: "tasks" })).toBeUndefined();
  });

  it("blocks the Google Calendar native surface for non-Calendar agents", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "mcp__google_calendar__search_events", params: {} },
      { agentId: "main" },
    )).toMatchObject({ block: true });
  });

  it("allows only configured reads for Calendar Agent", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "mcp__google_calendar__search_events", params: {} },
      { agentId: "calendar" },
    )).toBeUndefined();
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "mcp__google_calendar__delete_event", params: { event_id: "x" } },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
  });

  it("allows only a bounded classification-label write", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      {
        toolName: "mcp__google_calendar__set_event_label_silently",
        params: { event_id: "event-1", label_id: "label-strategy" },
      },
      { agentId: "calendar" },
    )).toBeUndefined();

    expect(calendarToolPolicy(
      VALID_CONFIG,
      {
        toolName: "mcp__google_calendar__set_event_label_silently",
        params: { event_id: "event-1", label_id: "label-strategy", title: "mutate me" },
      },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });

    expect(calendarToolPolicy(
      VALID_CONFIG,
      {
        toolName: "mcp__google_calendar__set_event_label_silently",
        params: { event_id: "event-1", label_id: "unknown-label" },
      },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
  });

  it("permits the technical Unclassified label but no other analytical mutation", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      {
        toolName: "mcp__google_calendar__set_event_label_silently",
        params: { event_id: "event-1", label_id: "label-unclassified" },
      },
      { agentId: "calendar" },
    )).toBeUndefined();
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "mcp__google_calendar__respond_event", params: { event_id: "event-1" } },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
  });

  it("fails closed on every unrelated Calendar-agent tool", () => {
    expect(calendarToolPolicy(VALID_CONFIG, { toolName: "exec", params: {} }, { agentId: "calendar" }))
      .toMatchObject({ block: true });
  });
});
