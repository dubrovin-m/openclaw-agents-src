import { describe, expect, it } from "vitest";
import { currentMoscowDate, holdingsArgs, parseInvestmentConfig, portfolioHubEnvironment, weeklyReviewArgs } from "./core.js";

describe("investment analytics core", () => {
  it("builds bounded weekly review arguments", () => {
    expect(weeklyReviewArgs("2026-10-01", 7)).toEqual([
      "-m", "portfolio_hub.weekly_review", "--end-date", "2026-10-01", "--days", "7", "--json",
    ]);
    expect(() => weeklyReviewArgs("2026-10-01;rm", 7)).toThrow();
    expect(() => weeklyReviewArgs("2026-10-01", 32)).toThrow();
  });

  it("builds bounded holdings arguments", () => {
    expect(holdingsArgs(50)).toEqual(["-m", "portfolio_hub.holdings", "--top", "50", "--json"]);
    expect(() => holdingsArgs(0)).toThrow();
    expect(() => holdingsArgs(101)).toThrow();
  });

  it("requires absolute runtime paths", () => {
    expect(parseInvestmentConfig({ portfolioHubRoot: "/srv/portfolio-hub", pythonPath: "/usr/bin/python3" }))
      .toEqual({ portfolioHubRoot: "/srv/portfolio-hub", pythonPath: "/usr/bin/python3" });
    expect(() => parseInvestmentConfig({ portfolioHubRoot: "relative", pythonPath: "/usr/bin/python3" })).toThrow();
  });

  it("does not propagate unrelated gateway environment into Portfolio Hub", () => {
    const env = portfolioHubEnvironment({ portfolioHubRoot: "/srv/portfolio-hub", pythonPath: "/usr/bin/python3" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "PYTHONPATH"].sort());
    expect(env.PYTHONPATH).toBe("/srv/portfolio-hub/src");
  });

  it("resolves Moscow date rather than host-local date", () => {
    expect(currentMoscowDate(new Date("2026-09-30T22:30:00Z"))).toBe("2026-10-01");
  });
});
