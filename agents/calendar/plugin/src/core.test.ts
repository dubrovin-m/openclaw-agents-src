import { describe, expect, it } from "vitest";
import { analyzeCalendar, parseCalendarConfig, reviewWindow } from "./core.js";
import { VALID_CONFIG } from "./test-fixture.js";

describe("Calendar config", () => {
  it("accepts a coherent hierarchy, guidance, and target model", () => {
    const parsed = parseCalendarConfig(VALID_CONFIG);
    expect(parsed.targets.parents.direction).toBe(60);
    expect(parsed.leaves[0].definition).toBe("Choose future direction.");
    expect(parsed.classificationRules).toHaveLength(2);
  });

  it("rejects missing classification guidance", () => {
    const { classificationRules: _classificationRules, ...withoutRules } = VALID_CONFIG;
    expect(() => parseCalendarConfig(withoutRules)).toThrow(/classificationRules/u);
  });

  it("rejects target drift between parent and leaves", () => {
    expect(() => parseCalendarConfig({
      ...VALID_CONFIG,
      targets: { ...VALID_CONFIG.targets, leaves: { strategy: 50, delivery: 50 } },
    })).toThrow(/equal its parent target/u);
  });

  it("rejects provider tool identities outside the configured prefix", () => {
    expect(() => parseCalendarConfig({
      ...VALID_CONFIG,
      providerTools: { ...VALID_CONFIG.providerTools, classificationWrite: "update_event" },
    })).toThrow(/must start with providerTools.prefix/u);
  });
});

describe("Review windows", () => {
  it("uses the Moscow weekday for Daily Review", () => {
    const window = reviewWindow("daily", "2026-09-21T07:30:00.000Z");
    expect(window.workDates).toEqual(["2026-09-21"]);
    expect(window.queryStart).toBe("2026-09-20T21:00:00.000Z");
    expect(window.queryEnd).toBe("2026-09-21T21:00:00.000Z");
  });

  it("resolves Friday Next Workday Review to Monday", () => {
    const window = reviewWindow("next_workday", "2026-09-25T14:00:00.000Z");
    expect(window.workDates).toEqual(["2026-09-28"]);
    expect(window.queryStart).toBe("2026-09-27T21:00:00.000Z");
    expect(window.queryEnd).toBe("2026-09-28T21:00:00.000Z");
  });

  it("uses the last ten working days for Biweekly Review", () => {
    expect(reviewWindow("biweekly", "2026-09-18T15:00:00.000Z").workDates).toEqual([
      "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11",
      "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
    ]);
  });

  it("does not define recurring Daily Review on a weekend", () => {
    expect(() => reviewWindow("daily", "2026-09-20T09:00:00.000Z")).toThrow(/weekends/u);
  });
});

describe("Deterministic allocation", () => {
  it("does not double count simultaneous intervals and leaves conflicting attribution explicit", () => {
    const result = analyzeCalendar(VALID_CONFIG, "daily", "2026-09-21T07:30:00.000Z", [
      { id: "A", start: "2026-09-21T10:00:00+03:00", end: "2026-09-21T12:00:00+03:00", classification: "strategy" },
      { id: "B", start: "2026-09-21T11:00:00+03:00", end: "2026-09-21T13:00:00+03:00", classification: "strategy" },
      { id: "C", start: "2026-09-21T13:00:00+03:00", end: "2026-09-21T14:00:00+03:00", classification: "service" },
      { id: "D", start: "2026-09-21T14:00:00+03:00", end: "2026-09-21T15:00:00+03:00", classification: null },
      { id: "E", start: "2026-09-21T18:00:00+03:00", end: "2026-09-21T20:00:00+03:00", classification: "delivery" },
      { id: "F", start: "2026-09-21T18:30:00+03:00", end: "2026-09-21T19:30:00+03:00", classification: "strategy" },
    ]);
    expect(result.hours).toEqual({
      scheduledLoad: 7,
      measuredWorkday: 10,
      management: 4,
      service: 1,
      unclassified: 1,
      overlapUnattributed: 1,
      freeWithinBaseline: 3,
      outsideBaselineLoad: 1,
    });
    expect(result.coverage.classificationPct).toBe(71.43);
    expect(result.coverage.excludedAllDayEvents).toBe(0);
    expect(result.leafAllocation.strategy.actualPct).toBe(75);
    expect(result.leafAllocation.strategy.deltaPct).toBe(15);
    expect(result.leafAllocation.delivery.actualPct).toBe(25);
    expect(result.parentAllocation.direction.actualPct).toBe(75);
  });

  it("excludes all-day events from timed workload arithmetic", () => {
    const result = analyzeCalendar(VALID_CONFIG, "daily", "2026-09-21T07:30:00.000Z", [
      { id: "all-day", start: "2026-09-21", end: "2026-09-22", allDay: true, classification: "service" },
      { id: "timed", start: "2026-09-21T10:00:00+03:00", end: "2026-09-21T11:00:00+03:00", classification: "service" },
    ]);
    expect(result.hours.scheduledLoad).toBe(1);
    expect(result.hours.service).toBe(1);
    expect(result.coverage.classificationPct).toBe(100);
    expect(result.coverage.excludedAllDayEvents).toBe(1);
  });

  it("excludes weekend events from recurring analytics", () => {
    const result = analyzeCalendar(VALID_CONFIG, "biweekly", "2026-09-18T15:00:00.000Z", [
      { id: "weekend", start: "2026-09-12T10:00:00+03:00", end: "2026-09-12T18:00:00+03:00", classification: "strategy" },
    ]);
    expect(result.hours.scheduledLoad).toBe(0);
    expect(result.hours.freeWithinBaseline).toBe(90);
  });
});
