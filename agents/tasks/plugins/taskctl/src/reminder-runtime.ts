import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { runReminderInternal } from "./index.js";

export const TASK_REMINDER_DISPATCH_TOOL = "task_reminder_dispatch";
export const REMINDER_DISPATCH_DECLARATION = "tasks.reminder-dispatch.v1";
export const REMINDER_DISPATCH_NAME = "tasks-reminder-dispatch";
export const REMINDER_DISPATCH_CRON = "* * * * *";
export const REMINDER_TIMEZONE = "Europe/Moscow";
const REMINDER_AGENT_ID = "tasks";
const REMINDER_ACCOUNT_ID = "tasks";

export const reminderDispatchParameters = Type.Object({}, { additionalProperties: false });

type SchedulerJob = {
  id: string;
  declarationKey?: string;
  agentId?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string; staggerMs?: number };
  sessionTarget?: string;
  payload?: { kind?: string };
  state?: { runningAtMs?: number };
};

type SchedulerService = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<SchedulerJob[]>;
};

type SchedulerGeneration = {
  service: SchedulerService;
  abortSignal: AbortSignal;
};

type JsonRecord = Record<string, unknown>;
let schedulerGeneration: SchedulerGeneration | undefined;
type ActiveClaim = { token: string; runAtMs: number };
const activeClaims = new Map<string, ActiveClaim[]>();
const knownReminderJobIds = new Set<string>();

function parseCurrentCronJobId(sessionKey: string | undefined, agentId?: string): string | null {
  if (agentId !== undefined && agentId !== REMINDER_AGENT_ID) return null;
  if (!sessionKey) return null;
  return /^agent:tasks:cron:([^:]+):trigger$/.exec(sessionKey)?.[1] ?? null;
}

function claimToken(jobId: string, runAtMs: number): string {
  if (!jobId.trim() || !Number.isFinite(runAtMs)) throw new Error("Reminder run identity is invalid");
  return `reminder:${jobId}:${Math.trunc(runAtMs)}`;
}

function requireSchedulerGeneration(): SchedulerGeneration {
  const generation = schedulerGeneration;
  if (!generation || generation.abortSignal.aborted) {
    throw new Error("Reminder scheduler projection is unavailable or stale");
  }
  return generation;
}

function validateReminderJob(job: SchedulerJob): SchedulerJob {
  if (job.declarationKey !== REMINDER_DISPATCH_DECLARATION) {
    throw new Error("Reminder dispatcher cron identity mismatch");
  }
  if (job.enabled !== true || job.agentId !== REMINDER_AGENT_ID || job.sessionTarget !== "isolated") {
    throw new Error("Reminder dispatcher must run as enabled isolated tasks agent");
  }
  if (
    job.schedule?.kind !== "cron" ||
    job.schedule.expr !== REMINDER_DISPATCH_CRON ||
    job.schedule.tz !== REMINDER_TIMEZONE ||
    (job.schedule.staggerMs !== undefined && job.schedule.staggerMs !== 0)
  ) {
    throw new Error("Reminder dispatcher schedule drift detected");
  }
  if (job.payload?.kind !== "script") throw new Error("Reminder dispatcher must use a script payload");
  return job;
}

async function findReminderJob(service: SchedulerService, jobId: string): Promise<SchedulerJob | null> {
  const jobs = await service.list({ includeDisabled: true });
  const matches = jobs.filter((job) => job.id === jobId);
  if (matches.length !== 1) return null;
  const job = matches[0]!;
  if (job.declarationKey !== REMINDER_DISPATCH_DECLARATION) return null;
  return validateReminderJob(job);
}

function requireObject(value: unknown, label: string): JsonRecord {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function requireSuccessfulTaskctl(value: unknown, label: string): JsonRecord {
  const record = requireObject(value, label);
  if (record.ok !== true) {
    const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? record.error as JsonRecord : null;
    throw new Error(`${label} failed: ${typeof error?.message === "string" ? error.message : "unknown error"}`);
  }
  return record;
}

function runningAtMs(job: SchedulerJob): number {
  const value = job.state?.runningAtMs;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Reminder dispatcher has no current runningAtMs");
  }
  return value;
}

export function buildReminderDispatchScript(): string {
  return [
    `const dispatch = await ${TASK_REMINDER_DISPATCH_TOOL}({});`,
    "json(dispatch.count > 0 ? { notify: dispatch.message } : {});",
  ].join("\n");
}

export async function executeReminderDispatch(
  toolContext: OpenClawPluginToolContext,
  deps: { signal?: AbortSignal } = {},
): Promise<JsonRecord> {
  const jobId = parseCurrentCronJobId(toolContext.sessionKey, toolContext.agentId);
  if (!jobId) throw new Error(`${TASK_REMINDER_DISPATCH_TOOL} is available only to a tasks cron session`);
  const generation = requireSchedulerGeneration();
  const job = await findReminderJob(generation.service, jobId);
  if (!job) throw new Error(`${TASK_REMINDER_DISPATCH_TOOL} is available only to the registered Reminder dispatcher`);
  generation.abortSignal.throwIfAborted();
  const runAtMs = runningAtMs(job);
  const result = requireSuccessfulTaskctl(await runReminderInternal("dispatch", {
    claim_token: claimToken(jobId, runAtMs),
    boundary: new Date(runAtMs).toISOString(),
  }, { signal: deps.signal }), "Reminder dispatch");
  if (!Number.isSafeInteger(result.count) || Number(result.count) < 0 || typeof result.message !== "string") {
    throw new Error("Reminder dispatch returned an invalid result");
  }
  knownReminderJobIds.add(jobId);
  if (Number(result.count) > 0) {
    const claims = activeClaims.get(jobId) ?? [];
    const token = claimToken(jobId, runAtMs);
    if (!claims.some((claim) => claim.token === token)) {
      claims.push({ token, runAtMs });
      activeClaims.set(jobId, claims);
    }
  }
  return result;
}

export function createReminderDispatchTool(
  toolContext: OpenClawPluginToolContext,
): AnyAgentTool | null {
  if (!parseCurrentCronJobId(toolContext.sessionKey, toolContext.agentId)) return null;
  return {
    name: TASK_REMINDER_DISPATCH_TOOL,
    label: "Task Reminder Dispatcher",
    description: "Claim due one-shot Reminders for the registered scheduler run; scheduler-only and not an ordinary Task mutation tool.",
    parameters: reminderDispatchParameters,
    execute: async (_toolCallId, _params, signal) => {
      const result = await executeReminderDispatch(toolContext, { signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

async function handleReplyPayloadSending(
  event: { payload: JsonRecord; sessionKey?: string },
  context: { channelId: string; accountId?: string; sessionKey?: string },
) {
  const jobId = parseCurrentCronJobId(event.sessionKey ?? context.sessionKey);
  if (!jobId) return undefined;
  const claims = activeClaims.get(jobId) ?? [];
  if (claims.length === 0) return undefined;
  const claim = claims.length === 1 ? claims[0] : undefined;
  if (!claim) return { cancel: true, reason: "reminder_claim_identity_ambiguous" };
  try {
    if (context.channelId !== "telegram" || context.accountId !== REMINDER_ACCOUNT_ID) {
      return { cancel: true, reason: "reminder_delivery_route_mismatch" };
    }
    const rendered = requireSuccessfulTaskctl(await runReminderInternal("render", { claim_token: claim.token }), "Reminder pre-send render");
    const count = Number(rendered.count);
    const message = rendered.message;
    if (!Number.isSafeInteger(count) || count < 0 || typeof message !== "string") {
      return { cancel: true, reason: "reminder_render_invalid" };
    }
    if (count === 0 || !message.trim()) return { cancel: true, reason: "reminder_claim_no_longer_active" };
    return { payload: { ...event.payload, text: message } };
  } catch {
    return { cancel: true, reason: "reminder_pre_send_revalidation_failed" };
  }
}

async function handleCronChanged(event: {
  action: string;
  jobId: string;
  runAtMs?: number;
  completionStatus?: string;
  delivered?: boolean;
  deliveryStatus?: string;
}) {
  if (event.action !== "finished" || typeof event.runAtMs !== "number" || !Number.isFinite(event.runAtMs)) return;
  if (!knownReminderJobIds.has(event.jobId)) return;
  const token = claimToken(event.jobId, event.runAtMs);
  const delivered = event.completionStatus === "succeeded" && event.delivered === true && event.deliveryStatus === "delivered";
  try {
    await runReminderInternal("settle", { claim_token: token, delivered });
  } finally {
    const remaining = (activeClaims.get(event.jobId) ?? []).filter((claim) => claim.token !== token);
    if (remaining.length) activeClaims.set(event.jobId, remaining); else activeClaims.delete(event.jobId);
  }
}

export function registerReminderRuntime(api: OpenClawPluginApi): void {
  api.on("cron_reconciled", (event, context) => {
    if (!event.enabled) {
      schedulerGeneration = undefined;
      return;
    }
    const service = context.getCron?.();
    if (!service) {
      schedulerGeneration = undefined;
      return;
    }
    schedulerGeneration = { service: service as SchedulerService, abortSignal: context.abortSignal };
  });
  api.on("reply_payload_sending", (event, context) => handleReplyPayloadSending(event as never, context));
  api.on("cron_changed", (event) => handleCronChanged(event));
  api.on("gateway_stop", () => { schedulerGeneration = undefined; activeClaims.clear(); knownReminderJobIds.clear(); });
}

export const reminderRuntimeInternals = {
  parseCurrentCronJobId,
  claimToken,
  validateReminderJob,
  findReminderJob,
  handleReplyPayloadSending,
  handleCronChanged,
  resetState: () => { schedulerGeneration = undefined; activeClaims.clear(); knownReminderJobIds.clear(); },
  activeClaims,
  knownReminderJobIds,
};
