import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  DAILY_REVIEW_DECLARATIONS,
  DAILY_REVIEW_GROUP_ID,
  TASK_DAILY_REVIEW_TOOL,
  buildDailyReviewScript,
  dailyReviewInternals,
  dailyReviewParameters,
  executeDailyReview,
} from "./daily-review.js";
import {
  advanceCheckpoint,
  checkpointPath,
  initializeCheckpoint,
  readCheckpoint,
  type DailyReviewCheckpointEntry,
} from "./daily-review-checkpoint.js";

const DAILY_REVIEW_AGENT_ID = "tasks";
const DAILY_REVIEW_TIMEZONE = "Europe/Moscow";
const RECEIPT_TOKEN = "[taskctl.daily-review.receipt.v1";
const RECEIPT_RE = /(?:\n\n)?\[taskctl\.daily-review\.receipt\.v1 last_delivered_run_at=([^\]\s]+)\]$/;
const SYNTHETIC_ACTIVATION_VALIDATED_ROUTE = "task-daily-review-activation-validated-route";

type DailyReviewParams = { group_id: typeof DAILY_REVIEW_GROUP_ID; bootstrap_checkpoint: string; peer_job_id: string };
type SchedulerJob = {
  id: string; declarationKey?: string; agentId?: string; description?: string; enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string; staggerMs?: number };
  sessionTarget?: string; payload?: { kind?: string; text?: string };
  state?: { lastRunAtMs?: number; lastRunStatus?: "ok" | "error" | "skipped"; lastDelivered?: boolean; lastDeliveryStatus?: "not-requested" | "delivered" | "not-delivered" | "unknown" };
};
type SchedulerService = { list: (opts?: { includeDisabled?: boolean }) => Promise<SchedulerJob[]> };
type Receipt = { baseDescription: string; lastDeliveredRunAtMs: number | null };

function parseInstant(value: string, label: string): { iso: string; ms: number } {
  const date = new Date(value);
  if (!value.trim() || Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid ISO timestamp`);
  return { iso: date.toISOString(), ms: date.getTime() };
}

function parseReceipt(description: string | undefined): Receipt {
  const value = description ?? "";
  const markerIndex = value.indexOf(RECEIPT_TOKEN);
  if (markerIndex < 0) return { baseDescription: value, lastDeliveredRunAtMs: null };
  const match = RECEIPT_RE.exec(value);
  if (!match || value.indexOf(RECEIPT_TOKEN, markerIndex + RECEIPT_TOKEN.length) >= 0) throw new Error("Daily Review Automation description contains malformed receipt metadata");
  return { baseDescription: value.slice(0, match.index), lastDeliveredRunAtMs: parseInstant(match[1] ?? "", "Daily Review receipt timestamp").ms };
}

function expectedSchedule(declarationKey: string | undefined) {
  if (declarationKey === DAILY_REVIEW_DECLARATIONS.morning) return { declaration: DAILY_REVIEW_DECLARATIONS.morning, peer: DAILY_REVIEW_DECLARATIONS.evening, expr: "30 9 * * *" } as const;
  if (declarationKey === DAILY_REVIEW_DECLARATIONS.evening) return { declaration: DAILY_REVIEW_DECLARATIONS.evening, peer: DAILY_REVIEW_DECLARATIONS.morning, expr: "0 17 * * *" } as const;
  throw new Error(`Unexpected Daily Review declarationKey: ${String(declarationKey)}`);
}

function validatePublicJob(job: SchedulerJob, label: string) {
  const expected = expectedSchedule(job.declarationKey);
  if (job.enabled !== true) throw new Error(`${label} Daily Review job must be enabled`);
  if (job.agentId !== DAILY_REVIEW_AGENT_ID || job.sessionTarget !== "isolated") throw new Error(`${label} Daily Review job must run as isolated tasks agent`);
  if (job.schedule?.kind !== "cron" || job.schedule.expr !== expected.expr || job.schedule.tz !== DAILY_REVIEW_TIMEZONE || (job.schedule.staggerMs !== undefined && job.schedule.staggerMs !== 0)) throw new Error(`${label} Daily Review schedule drift detected`);
  if (job.payload?.kind !== "script") throw new Error(`${label} Daily Review job must use a script payload`);
  return expected;
}

function validatePair(jobs: SchedulerJob[]) {
  const declared = jobs.filter((job) => job.declarationKey === DAILY_REVIEW_DECLARATIONS.morning || job.declarationKey === DAILY_REVIEW_DECLARATIONS.evening);
  if (declared.length !== 2) throw new Error(`Daily Review requires exactly two declared schedule entries; found ${declared.length}`);
  const morning = declared.find((job) => job.declarationKey === DAILY_REVIEW_DECLARATIONS.morning)!;
  const evening = declared.find((job) => job.declarationKey === DAILY_REVIEW_DECLARATIONS.evening)!;
  validatePublicJob(morning, "morning"); validatePublicJob(evening, "evening");
  return { morning, evening };
}

function visibleSuccessfulDelivery(job: SchedulerJob): number | null {
  const runAtMs = job.state?.lastRunAtMs;
  if (runAtMs === undefined) return null;
  if (!Number.isFinite(runAtMs)) throw new Error(`Daily Review scheduler state for ${job.id} has invalid lastRunAtMs`);
  return job.state?.lastRunStatus === "ok" && job.state.lastDelivered === true && job.state.lastDeliveryStatus === "delivered" ? runAtMs : null;
}

function migrationEntry(job: SchedulerJob): DailyReviewCheckpointEntry {
  const expected = expectedSchedule(job.declarationKey);
  const receipt = parseReceipt(job.description).lastDeliveredRunAtMs;
  const visible = visibleSuccessfulDelivery(job);
  const latest = Math.max(receipt ?? Number.NEGATIVE_INFINITY, visible ?? Number.NEGATIVE_INFINITY);
  return { jobId: job.id, declarationKey: expected.declaration, lastDeliveredRunAtMs: Number.isFinite(latest) ? latest : null };
}

function successfulEntry(runAtMs: number) { return { status: "ok", completionStatus: "succeeded", delivered: true, deliveryStatus: "delivered", runAtMs }; }

function projectedJob(entry: DailyReviewCheckpointEntry, params: DailyReviewParams, peerJobId: string, runningAtMs?: number) {
  const expected = expectedSchedule(entry.declarationKey);
  return {
    id: entry.jobId, declarationKey: entry.declarationKey, agentId: DAILY_REVIEW_AGENT_ID, enabled: true,
    schedule: { kind: "cron", expr: expected.expr, tz: DAILY_REVIEW_TIMEZONE, staggerMs: 0 },
    sessionTarget: "isolated", wakeMode: "now",
    payload: { kind: "script", script: buildDailyReviewScript({ ...params, peer_job_id: peerJobId }), toolsAllow: [TASK_DAILY_REVIEW_TOOL] },
    delivery: { mode: "announce", channel: "telegram", to: SYNTHETIC_ACTIVATION_VALIDATED_ROUTE, accountId: DAILY_REVIEW_AGENT_ID, bestEffort: false },
    state: runningAtMs === undefined ? {} : { runningAtMs },
  };
}

export async function prepareDailyReviewRuntimeProjection(params: DailyReviewParams, toolContext: OpenClawPluginToolContext, options?: { path?: string; boundaryMs?: number }) {
  const currentJobId = dailyReviewInternals.parseCurrentCronJobId(toolContext);
  if (!currentJobId) throw new Error(`${TASK_DAILY_REVIEW_TOOL} is available only to the tasks cron script runtime`);
  if (params.peer_job_id === currentJobId) throw new Error("Daily Review peer_job_id must identify the sibling schedule entry");
  const bootstrap = parseInstant(params.bootstrap_checkpoint, "bootstrap_checkpoint");
  const boundaryMs = options?.boundaryMs ?? Date.now();
  if (!Number.isFinite(boundaryMs) || boundaryMs < bootstrap.ms) throw new Error("Daily Review current run has invalid snapshot boundary");
  const checkpoint = await readCheckpoint(options?.path ?? checkpointPath());
  const entries = Object.values(checkpoint.jobs);
  const current = entries.find((entry) => entry.jobId === currentJobId);
  const peer = entries.find((entry) => entry.jobId === params.peer_job_id);
  if (!current || !peer || current.declarationKey === peer.declarationKey) throw new Error("Daily Review checkpoint does not match the configured job pair");
  for (const entry of entries) {
    if (entry.lastDeliveredRunAtMs !== null && (entry.lastDeliveredRunAtMs < bootstrap.ms || entry.lastDeliveredRunAtMs >= boundaryMs)) throw new Error(`Daily Review checkpoint for ${entry.jobId} is outside the active review window`);
  }
  const projected = new Map([
    [current.jobId, projectedJob(current, params, peer.jobId, boundaryMs)],
    [peer.jobId, projectedJob(peer, params, current.jobId)],
  ]);
  const histories = new Map(entries.map((entry) => [entry.jobId, entry.lastDeliveredRunAtMs === null ? [] : [successfulEntry(entry.lastDeliveredRunAtMs)]]));
  return async (method: "cron.get" | "cron.runs", request: Record<string, unknown>) => {
    const id = typeof request.id === "string" ? request.id : "";
    if (!projected.has(id)) throw new Error(`Daily Review requested scheduler data outside the validated pair: ${id}`);
    if (method === "cron.get") return projected.get(id);
    const entries = histories.get(id) ?? [];
    const offset = Number.isSafeInteger(request.offset) && Number(request.offset) >= 0 ? Number(request.offset) : 0;
    const limit = Number.isSafeInteger(request.limit) && Number(request.limit) > 0 ? Math.min(Number(request.limit), 200) : 200;
    const page = entries.slice(offset, offset + limit); const nextOffset = offset + page.length;
    return { entries: page, total: entries.length, offset, limit, hasMore: nextOffset < entries.length, nextOffset: nextOffset < entries.length ? nextOffset : null };
  };
}

export function registerDailyReviewSchedulerAccess(api: OpenClawPluginApi): void {
  let statePath: string | undefined;
  api.registerService({
    id: "taskctl-daily-review-checkpoint",
    start: async (context) => {
      statePath = checkpointPath(context.stateDir);
      const service = context.getCron?.() as SchedulerService | undefined;
      if (!service) throw new Error("Daily Review checkpoint initialization requires native Automation access");
      const { morning, evening } = validatePair(await service.list({ includeDisabled: true }));
      await initializeCheckpoint({ path: statePath, entries: [migrationEntry(morning), migrationEntry(evening)] });
    },
    stop: () => { statePath = undefined; },
  });
  api.on("cron_changed", async (event) => {
    if (event.action !== "finished" || event.status !== "ok" || event.completionStatus !== "succeeded" || event.delivered !== true || event.deliveryStatus !== "delivered" || typeof event.runAtMs !== "number") return;
    if (!statePath) throw new Error("Daily Review checkpoint service is unavailable");
    try { await advanceCheckpoint({ path: statePath, jobId: event.jobId, runAtMs: event.runAtMs }); }
    catch (error) {
      if (String((error as Error).message).includes("unknown job")) return;
      throw error;
    }
  });
}

export function createDailyReviewTool(api: OpenClawPluginApi, toolContext: OpenClawPluginToolContext): AnyAgentTool | null {
  if (!dailyReviewInternals.parseCurrentCronJobId(toolContext)) return null;
  return {
    name: TASK_DAILY_REVIEW_TOOL, label: "Task Daily Review",
    description: "Build one fail-closed scheduler-only Daily Review snapshot and semantic duplicate warning set without Task mutations.",
    parameters: dailyReviewParameters,
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as DailyReviewParams;
      const readGateway = await prepareDailyReviewRuntimeProjection(params, toolContext);
      const result = await executeDailyReview(params, { api, toolContext, signal, readGateway });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

export const dailyReviewRuntimeInternals = { parseReceipt, visibleSuccessfulDelivery, validatePublicJob, validatePair, migrationEntry };
