import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAILY_REVIEW_DECLARATIONS, DAILY_REVIEW_GROUP_ID, executeDailyReview } from "./daily-review.js";
import { advanceCheckpoint, checkpointPath, initializeCheckpoint, readCheckpoint } from "./daily-review-checkpoint.js";
import { dailyReviewRuntimeInternals, prepareDailyReviewRuntimeProjection, registerDailyReviewSchedulerAccess } from "./daily-review-runtime.js";

const BOOTSTRAP = "2026-09-05T06:00:00.000Z";
const BOUNDARY_MS = Date.parse("2026-09-07T06:30:00.000Z");
const MORNING_MS = Date.parse("2026-09-06T06:30:00.000Z");
const EVENING_MS = Date.parse("2026-09-06T14:00:00.000Z");
const params = { group_id: DAILY_REVIEW_GROUP_ID, bootstrap_checkpoint: BOOTSTRAP, peer_job_id: "evening-job" } as const;
const toolContext = { agentId: "tasks", sessionKey: "agent:tasks:cron:morning-job:trigger" } as never;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function tempState() { const root = await mkdtemp(join(tmpdir(), "taskctl-dr-")); roots.push(root); return { root, path: checkpointPath(root) }; }
function receipt(ms: number) { return `[taskctl.daily-review.receipt.v1 last_delivered_run_at=${new Date(ms).toISOString()}]`; }
function job(options: { id: string; declarationKey: string; expr: string; description?: string; lastRunAtMs?: number; delivered?: boolean }) {
  return { id: options.id, declarationKey: options.declarationKey, agentId: "tasks", description: options.description, enabled: true,
    schedule: { kind: "cron", expr: options.expr, tz: "Europe/Moscow", staggerMs: 0 }, sessionTarget: "isolated", payload: { kind: "script" },
    state: { lastRunAtMs: options.lastRunAtMs, lastRunStatus: options.lastRunAtMs ? "ok" as const : undefined, lastDelivered: options.delivered, lastDeliveryStatus: options.delivered ? "delivered" as const : undefined } };
}
function pair() { return [job({ id: "morning-job", declarationKey: DAILY_REVIEW_DECLARATIONS.morning, expr: "30 9 * * *", description: receipt(MORNING_MS) }), job({ id: "evening-job", declarationKey: DAILY_REVIEW_DECLARATIONS.evening, expr: "0 17 * * *", description: receipt(EVENING_MS) })]; }
async function seed(path: string, morning: number | null = MORNING_MS, evening: number | null = EVENING_MS) {
  return initializeCheckpoint({ path, entries: [
    { jobId: "morning-job", declarationKey: DAILY_REVIEW_DECLARATIONS.morning, lastDeliveredRunAtMs: morning },
    { jobId: "evening-job", declarationKey: DAILY_REVIEW_DECLARATIONS.evening, lastDeliveredRunAtMs: evening },
  ] });
}

describe("Daily Review durable checkpoint", () => {
  it("migrates deterministic legacy receipts without changing Automation definitions", async () => {
    const { root, path } = await tempState(); const jobs = pair();
    let service: { start: (ctx: unknown) => Promise<void>; stop: () => void } | undefined;
    const api = { registerService: vi.fn((value) => { service = value; }), on: vi.fn() };
    registerDailyReviewSchedulerAccess(api as never);
    await service!.start({ stateDir: root, getCron: () => ({ list: async () => jobs }) });
    expect((await readCheckpoint(path)).jobs[DAILY_REVIEW_DECLARATIONS.evening].lastDeliveredRunAtMs).toBe(EVENING_MS);
    expect(jobs.map((entry) => entry.description)).toEqual([receipt(MORNING_MS), receipt(EVENING_MS)]);
    service!.stop();
  });

  it("fresh Cron tool runtime reads durable state with no Gateway-side binding", async () => {
    const { path } = await tempState(); await seed(path);
    const reader = await prepareDailyReviewRuntimeProjection(params, toolContext, { path, boundaryMs: BOUNDARY_MS });
    const history = await reader("cron.runs", { id: "evening-job", limit: 200, offset: 0 }) as { entries: Array<{ runAtMs: number }> };
    expect(history.entries.map((entry) => entry.runAtMs)).toEqual([EVENING_MS]);
  });

  it("advances monotonically so an older concurrent completion cannot overwrite a newer checkpoint", async () => {
    const { path } = await tempState(); await seed(path, null, null);
    await Promise.all([advanceCheckpoint({ path, jobId: "morning-job", runAtMs: EVENING_MS }), advanceCheckpoint({ path, jobId: "morning-job", runAtMs: MORNING_MS })]);
    expect((await readCheckpoint(path)).jobs[DAILY_REVIEW_DECLARATIONS.morning].lastDeliveredRunAtMs).toBe(EVENING_MS);
  });

  it("cron_changed advances only completed and delivered success", async () => {
    const { root, path } = await tempState(); const jobs = pair().map((entry) => ({ ...entry, description: undefined, state: {} }));
    let service: { start: (ctx: unknown) => Promise<void> } | undefined; let changed: ((event: Record<string, unknown>) => Promise<void>) | undefined;
    const api = { registerService: vi.fn((value) => { service = value; }), on: vi.fn((name, handler) => { if (name === "cron_changed") changed = handler; }) };
    registerDailyReviewSchedulerAccess(api as never); await service!.start({ stateDir: root, getCron: () => ({ list: async () => jobs }) });
    await changed!({ action: "finished", jobId: "morning-job", runAtMs: MORNING_MS, status: "ok", completionStatus: "succeeded", delivered: false, deliveryStatus: "not-delivered" });
    expect((await readCheckpoint(path)).jobs[DAILY_REVIEW_DECLARATIONS.morning].lastDeliveredRunAtMs).toBeNull();
    await changed!({ action: "finished", jobId: "morning-job", runAtMs: MORNING_MS, status: "ok", completionStatus: "succeeded", delivered: true, deliveryStatus: "delivered" });
    expect((await readCheckpoint(path)).jobs[DAILY_REVIEW_DECLARATIONS.morning].lastDeliveredRunAtMs).toBe(MORNING_MS);
  });

  it("suppresses a retry only for a delivered checkpoint from the same slot and Moscow date", async () => {
    const { path } = await tempState(); const sameDayMorning = BOUNDARY_MS - 60_000; await seed(path, sameDayMorning, EVENING_MS);
    const readGateway = await prepareDailyReviewRuntimeProjection(params, toolContext, { path, boundaryMs: BOUNDARY_MS });
    const result = await executeDailyReview(params, { api: {} as never, toolContext, readGateway: readGateway as never, loadSnapshot: vi.fn(() => ({ inboxCount: 0, tasks: [] })), runSemanticModel: vi.fn(async () => '{"pairs":[]}') });
    expect(result.suppress).toBe(true);
  });

  it("fixes the snapshot boundary before Task retrieval", async () => {
    const { path } = await tempState(); await seed(path); const readGateway = await prepareDailyReviewRuntimeProjection(params, toolContext, { path, boundaryMs: BOUNDARY_MS });
    const loader = vi.fn((boundary: string) => { expect(boundary).toBe(new Date(BOUNDARY_MS).toISOString()); return { inboxCount: 0, tasks: [] }; });
    const result = await executeDailyReview(params, { api: {} as never, toolContext, readGateway: readGateway as never, loadSnapshot: loader, runSemanticModel: vi.fn(async () => '{"pairs":[]}') });
    expect(result.snapshot_boundary).toBe(new Date(BOUNDARY_MS).toISOString()); expect(loader).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed, stale, or mismatched projection", async () => {
    const { path } = await tempState(); await seed(path); const raw = JSON.parse(await readFile(path, "utf8")); raw.jobs[DAILY_REVIEW_DECLARATIONS.morning].jobId = "wrong-job";
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(raw)));
    await expect(prepareDailyReviewRuntimeProjection(params, toolContext, { path, boundaryMs: BOUNDARY_MS })).rejects.toThrow(/does not match/);
  });

  it("legacy receipt parser remains strict for deterministic migration", () => {
    expect(dailyReviewRuntimeInternals.parseReceipt(`Daily review\n\n${receipt(MORNING_MS)}`).lastDeliveredRunAtMs).toBe(MORNING_MS);
    expect(() => dailyReviewRuntimeInternals.parseReceipt("[taskctl.daily-review.receipt.v1 last_delivered_run_at=bad]")).toThrow(/valid ISO/);
  });
});
