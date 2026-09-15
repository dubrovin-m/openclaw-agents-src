import { describe, expect, it, vi } from "vitest";
import {
  DAILY_REVIEW_DECLARATIONS,
  DAILY_REVIEW_GROUP_ID,
  executeDailyReview,
} from "./daily-review.js";
import {
  dailyReviewRuntimeInternals,
  prepareDailyReviewRuntimeProjection,
} from "./daily-review-runtime.js";

const BOOTSTRAP = "2026-09-05T06:00:00.000Z";
const BOUNDARY_MS = Date.parse("2026-09-07T06:30:00.000Z");
const PREVIOUS_MORNING_MS = Date.parse("2026-09-06T06:30:00.000Z");
const PREVIOUS_EVENING_MS = Date.parse("2026-09-06T14:00:00.000Z");

const params = {
  group_id: DAILY_REVIEW_GROUP_ID,
  bootstrap_checkpoint: BOOTSTRAP,
  peer_job_id: "evening-job",
} as const;

const toolContext = {
  agentId: "tasks",
  sessionKey: "agent:tasks:cron:morning-job:trigger",
} as never;

function job(options: {
  id: string;
  declarationKey: string;
  expr: string;
  description?: string;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: "ok" | "error" | "skipped";
  lastDelivered?: boolean;
  lastDeliveryStatus?: "not-requested" | "delivered" | "not-delivered" | "unknown";
}) {
  return {
    id: options.id,
    declarationKey: options.declarationKey,
    agentId: "tasks",
    name: `Daily Review ${options.id}`,
    description: options.description,
    enabled: true,
    schedule: {
      kind: "cron",
      expr: options.expr,
      tz: "Europe/Moscow",
      staggerMs: 0,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "script" },
    state: {
      runningAtMs: options.runningAtMs,
      lastRunAtMs: options.lastRunAtMs,
      lastRunStatus: options.lastRunStatus,
      lastDelivered: options.lastDelivered,
      lastDeliveryStatus: options.lastDeliveryStatus,
    },
  };
}

function pair(options?: {
  currentDescription?: string;
  currentLastRunAtMs?: number;
  currentLastRunStatus?: "ok" | "error" | "skipped";
  currentLastDelivered?: boolean;
  currentLastDeliveryStatus?: "not-requested" | "delivered" | "not-delivered" | "unknown";
  peerDescription?: string;
  peerLastRunAtMs?: number;
  peerLastRunStatus?: "ok" | "error" | "skipped";
  peerLastDelivered?: boolean;
  peerLastDeliveryStatus?: "not-requested" | "delivered" | "not-delivered" | "unknown";
}) {
  return [
    job({
      id: "morning-job",
      declarationKey: DAILY_REVIEW_DECLARATIONS.morning,
      expr: "30 9 * * *",
      description: options?.currentDescription,
      runningAtMs: BOUNDARY_MS,
      lastRunAtMs: options?.currentLastRunAtMs,
      lastRunStatus: options?.currentLastRunStatus,
      lastDelivered: options?.currentLastDelivered,
      lastDeliveryStatus: options?.currentLastDeliveryStatus,
    }),
    job({
      id: "evening-job",
      declarationKey: DAILY_REVIEW_DECLARATIONS.evening,
      expr: "0 17 * * *",
      description: options?.peerDescription,
      lastRunAtMs: options?.peerLastRunAtMs,
      lastRunStatus: options?.peerLastRunStatus,
      lastDelivered: options?.peerLastDelivered,
      lastDeliveryStatus: options?.peerLastDeliveryStatus,
    }),
  ];
}

function scheduler(jobs: ReturnType<typeof pair>, onUpdate?: () => void) {
  const updates: Array<{ id: string; description?: string }> = [];
  const service = {
    list: vi.fn(async () => jobs),
    update: vi.fn(async (id: string, patch: { description?: string }) => {
      updates.push({ id, ...patch });
      const target = jobs.find((entry) => entry.id === id);
      if (target && patch.description !== undefined) target.description = patch.description;
      onUpdate?.();
      return target;
    }),
  };
  return { service, updates };
}

function projectionDeps(service: ReturnType<typeof scheduler>["service"], abortSignal?: AbortSignal) {
  return {
    service: service as never,
    abortSignal: abortSignal ?? new AbortController().signal,
  };
}

describe("Daily Review native Automation receipt", () => {
  it("round-trips one exact receipt while preserving operator description", () => {
    const description = dailyReviewRuntimeInternals.withReceipt("Daily review", PREVIOUS_EVENING_MS);
    expect(description).toContain("Daily review\n\n[taskctl.daily-review.receipt.v1");
    expect(dailyReviewRuntimeInternals.parseReceipt(description)).toEqual({
      baseDescription: "Daily review",
      lastDeliveredRunAtMs: PREVIOUS_EVENING_MS,
    });
  });

  it("rejects malformed or duplicated receipt metadata fail-closed", () => {
    expect(() =>
      dailyReviewRuntimeInternals.parseReceipt(
        "Daily review\n\n[taskctl.daily-review.receipt.v1 last_delivered_run_at=not-a-date]",
      ),
    ).toThrow(/valid ISO timestamp/);
    expect(() =>
      dailyReviewRuntimeInternals.parseReceipt(
        "[taskctl.daily-review.receipt.v1 last_delivered_run_at=2026-09-06T06:30:00.000Z]\n" +
          "[taskctl.daily-review.receipt.v1 last_delivered_run_at=2026-09-06T14:00:00.000Z]",
      ),
    ).toThrow(/malformed receipt/);
  });

  it("promotes only a confirmed native delivered success and does so monotonically", async () => {
    const jobs = pair({
      currentDescription: dailyReviewRuntimeInternals.withReceipt("Morning", PREVIOUS_MORNING_MS),
      currentLastRunAtMs: PREVIOUS_EVENING_MS,
      currentLastRunStatus: "ok",
      currentLastDelivered: true,
      currentLastDeliveryStatus: "delivered",
    });
    const { service, updates } = scheduler(jobs);
    const promoted = await dailyReviewRuntimeInternals.promoteReceipt({
      job: jobs[0],
      boundaryMs: BOUNDARY_MS,
      bootstrapMs: Date.parse(BOOTSTRAP),
      deps: projectionDeps(service),
    });
    expect(promoted).toBe(PREVIOUS_EVENING_MS);
    expect(updates).toHaveLength(1);
    expect(dailyReviewRuntimeInternals.parseReceipt(updates[0]!.description)).toMatchObject({
      lastDeliveredRunAtMs: PREVIOUS_EVENING_MS,
    });
  });

  it("does not promote payload success when required delivery was not confirmed", async () => {
    const jobs = pair({
      currentLastRunAtMs: PREVIOUS_MORNING_MS,
      currentLastRunStatus: "ok",
      currentLastDelivered: false,
      currentLastDeliveryStatus: "not-delivered",
    });
    const { service, updates } = scheduler(jobs);
    const promoted = await dailyReviewRuntimeInternals.promoteReceipt({
      job: jobs[0],
      boundaryMs: BOUNDARY_MS,
      bootstrapMs: Date.parse(BOOTSTRAP),
      deps: projectionDeps(service),
    });
    expect(promoted).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it("keeps the durable receipt when a later failed run overwrote public last-run state", async () => {
    const jobs = pair({
      currentDescription: dailyReviewRuntimeInternals.withReceipt("Morning", PREVIOUS_MORNING_MS),
      currentLastRunAtMs: PREVIOUS_EVENING_MS,
      currentLastRunStatus: "error",
      currentLastDelivered: false,
      currentLastDeliveryStatus: "not-delivered",
    });
    const { service, updates } = scheduler(jobs);
    const reader = await prepareDailyReviewRuntimeProjection(
      params,
      toolContext,
      projectionDeps(service),
    );
    const history = (await reader("cron.runs", {
      id: "morning-job",
      offset: 0,
      limit: 200,
    })) as { entries: Array<{ runAtMs: number }> };
    expect(history.entries.map((entry) => entry.runAtMs)).toEqual([PREVIOUS_MORNING_MS]);
    expect(updates).toHaveLength(0);
  });

  it("preserves the latest group checkpoint across the morning/evening pair", async () => {
    const jobs = pair({
      currentLastRunAtMs: PREVIOUS_MORNING_MS,
      currentLastRunStatus: "ok",
      currentLastDelivered: true,
      currentLastDeliveryStatus: "delivered",
      peerLastRunAtMs: PREVIOUS_EVENING_MS,
      peerLastRunStatus: "ok",
      peerLastDelivered: true,
      peerLastDeliveryStatus: "delivered",
    });
    const { service } = scheduler(jobs);
    const readGateway = await prepareDailyReviewRuntimeProjection(
      params,
      toolContext,
      projectionDeps(service),
    );
    const result = await executeDailyReview(params, {
      api: {} as never,
      toolContext,
      readGateway: readGateway as never,
      loadSnapshot: () => ({ inboxCount: 0, tasks: [] }),
      runSemanticModel: vi.fn(async () => '{"pairs":[]}'),
    });
    expect(result.previous_successful_checkpoint).toBe(
      new Date(PREVIOUS_EVENING_MS).toISOString(),
    );
  });

  it("suppresses a retry when this occurrence already has a promoted successful delivery", async () => {
    const sameOccurrenceMs = BOUNDARY_MS - 60_000;
    const jobs = pair({
      currentDescription: dailyReviewRuntimeInternals.withReceipt("Morning", sameOccurrenceMs),
      currentLastRunAtMs: BOUNDARY_MS - 30_000,
      currentLastRunStatus: "error",
      currentLastDelivered: false,
      currentLastDeliveryStatus: "not-delivered",
    });
    const { service } = scheduler(jobs);
    const readGateway = await prepareDailyReviewRuntimeProjection(
      params,
      toolContext,
      projectionDeps(service),
    );
    const model = vi.fn(async () => '{"pairs":[]}');
    const result = await executeDailyReview(params, {
      api: {} as never,
      toolContext,
      readGateway: readGateway as never,
      loadSnapshot: () => ({ inboxCount: 0, tasks: [] }),
      runSemanticModel: model,
    });
    expect(result.suppress).toBe(true);
    expect(model).not.toHaveBeenCalled();
  });

  it("rejects stale scheduler generation after a receipt write", async () => {
    const controller = new AbortController();
    const jobs = pair({
      currentLastRunAtMs: PREVIOUS_MORNING_MS,
      currentLastRunStatus: "ok",
      currentLastDelivered: true,
      currentLastDeliveryStatus: "delivered",
    });
    const { service } = scheduler(jobs, () => controller.abort());
    await expect(
      prepareDailyReviewRuntimeProjection(
        params,
        toolContext,
        projectionDeps(service, controller.signal),
      ),
    ).rejects.toThrow();
  });

  it("fails closed on exposed schedule drift instead of projecting synthetic success", async () => {
    const jobs = pair();
    jobs[1].schedule.expr = "5 17 * * *";
    const { service } = scheduler(jobs);
    await expect(
      prepareDailyReviewRuntimeProjection(params, toolContext, projectionDeps(service)),
    ).rejects.toThrow(/schedule drift/);
  });
});
