import { describe, expect, it } from "vitest";
import { calendarToolPolicy } from "./policy.js";
import { proposeRule } from "./rules.js";
import { VALID_CONFIG } from "./test-fixture.js";

const EVENT_REF = "evt_20260922_0123456789abcdef";
const RULE_CONFIG = { ...VALID_CONFIG, durableRules: { classification: [], hygiene: [] } };

describe("Calendar tool policy", () => {
  it("does not affect unrelated tools for other agents", () => {
    expect(calendarToolPolicy(VALID_CONFIG, { toolName: "task_list", params: {} }, { agentId: "tasks" })).toBeUndefined();
  });

  it("blocks the Google Calendar provider and durable-rule surfaces for non-Calendar agents", () => {
    expect(calendarToolPolicy(
      VALID_CONFIG,
      { toolName: "calendar_provider_list_events", params: {} },
      { agentId: "main" },
    )).toMatchObject({ block: true });
    expect(calendarToolPolicy(
      RULE_CONFIG,
      { toolName: "calendar_rule_propose", params: {} },
      { agentId: "main" },
    )).toMatchObject({ block: true });
    expect(calendarToolPolicy(
      RULE_CONFIG,
      { toolName: "calendar_rule_commit", params: { proposal_id: "proposal_0000000000000000" } },
      { agentId: "main" },
    )).toMatchObject({ block: true });
  });

  it("allows only configured reads and bounded rule proposals for Calendar Agent", () => {
    expect(calendarToolPolicy(
      RULE_CONFIG,
      { toolName: "calendar_provider_list_events", params: {} },
      { agentId: "calendar" },
    )).toBeUndefined();
    expect(calendarToolPolicy(
      RULE_CONFIG,
      { toolName: "calendar_rule_propose", params: {} },
      { agentId: "calendar" },
    )).toBeUndefined();
    expect(calendarToolPolicy(
      RULE_CONFIG,
      { toolName: "calendar_provider_delete_event", params: { event_id: "x" } },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
  });

  it("requires native allow-once approval for an exact durable-rule proposal", () => {
    const proposal = proposeRule(RULE_CONFIG, {
      action: "create",
      kind: "hygiene_exception",
      condition: "Purpose is interview",
      require_leader: false,
      require_agenda: false,
    });
    expect(calendarToolPolicy(
      RULE_CONFIG,
      { toolName: "calendar_rule_commit", params: { proposal_id: proposal.proposal_id } },
      { agentId: "calendar" },
    )).toMatchObject({
      requireApproval: {
        title: "Сохранить правило Calendar",
        description: proposal.summary,
        allowedDecisions: ["allow-once", "deny"],
        severity: "warning",
      },
    });
  });

  it("blocks unknown or malformed durable-rule commits", () => {
    expect(calendarToolPolicy(
      RULE_CONFIG,
      { toolName: "calendar_rule_commit", params: { proposal_id: "proposal_0000000000000000" } },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
    expect(calendarToolPolicy(
      RULE_CONFIG,
      { toolName: "calendar_rule_commit", params: { proposal_id: "bad" } },
      { agentId: "calendar" },
    )).toMatchObject({ block: true });
    expect(calendarToolPolicy(
      RULE_CONFIG,
      { toolName: "calendar_rule_commit", params: { proposal_id: "proposal_0000000000000000", rule: "nope" } },
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
