import { describe, expect, it } from "vitest";
import {
  buildManagementReviewScript,
  executeManagementReview,
  managementReviewInternals,
  TASK_MANAGEMENT_REVIEW_TOOL,
} from "./management-review.js";

describe("Task Management Review scheduler-only tool", () => {
  it("builds a script that fixes a boundary before the snapshot call", () => {
    const script = buildManagementReviewScript();
    expect(script).toContain(
      `await ${TASK_MANAGEMENT_REVIEW_TOOL}({ boundary: new Date().toISOString() })`,
    );
    expect(script).toContain("notify: review.message");
  });

  it("is context-gated to tasks cron session keys", () => {
    expect(managementReviewInternals.parseCurrentCronJobId({
      agentId: "tasks",
      sessionKey: "agent:tasks:cron:job-1:trigger",
    } as never)).toBe("job-1");
    expect(managementReviewInternals.parseCurrentCronJobId({
      agentId: "tasks",
      sessionKey: "agent:tasks:main",
    } as never)).toBeNull();
  });

  it("fails closed when the snapshot boundary or message is inconsistent", async () => {
    await expect(executeManagementReview(
      { boundary: "2026-09-16T16:00:00.000Z" },
      { runSnapshot: async () => ({
        ok: true,
        boundary: "2026-09-16T15:00:00.000Z",
        message: "x",
      }) },
    )).rejects.toThrow("boundary mismatch");

    await expect(executeManagementReview(
      { boundary: "2026-09-16T16:00:00.000Z" },
      { runSnapshot: async () => ({
        ok: true,
        boundary: "2026-09-16T16:00:00.000Z",
      }) },
    )).rejects.toThrow("no message");
  });
});
