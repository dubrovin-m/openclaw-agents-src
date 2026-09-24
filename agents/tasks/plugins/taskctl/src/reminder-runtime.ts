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
const REMINDER_CHANNEL_ID = "telegram";

export const reminderDispatchParameters = Type.Object({}, { additionalProperties: false });

type SchedulerJob = {
  id: string;
  declarationKey?: string;
  agentId?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string; staggerMs?: number };
  sessionTarget?: string;
  payload?: { kind?: string; script?: string; toolsAllow?: string[] };
  delivery?: { mode?: string; channel?: string; accountId?: string; to?: string; bestEffort?: boolean };
  state?: { runningAtMs?: number };
};

type SchedulerService = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<SchedulerJob[]>;
};

type DispatcherProjection = {
  kind: "dispatcher";
  jobId: string;
  expectedRecipient: string;
};

type RunProjection = {
  kind: "run";
  jobId: string;
  runAtMs: number;
  expectedRecipient: string;
  projectedAtMs: number;
};

type ReminderStateValue = DispatcherProjection | RunProjection;

type ReminderStateStore = {
  register: (key: string, value: ReminderStateValue, opts?: { ttlMs?: number }) => Promise<void>;
  lookup: (key: string) => Promise<ReminderStateValue | undefined>;
  delete: (key: string) => Promise<boolean>;
  clear: () => Promise<void>;
};

type JsonRecord = Record<string, unknown>;
let reminderStateStore: ReminderStateStore | undefined;

function parseCurrentCronJobId(sessionKey: string | undefined, agentId?: string): string | null {
  if (agentId !== undefined && agentId !== REMINDER_AGENT_ID) return null;
  if (!sessionKey) return null;
  return /^agent:tasks:cron:([^:]+):trigger$/.exec(sessionKey)?.[1] ?? null;
}

function claimToken(jobId: string, runAtMs: number): string {
  if (!jobId.trim() || !Number.isFinite(runAtMs)) throw new Error("Reminder run identity is invalid");
  return `reminder:${jobId}:${Math.trunc(runAtMs)}`;
}

const REMINDER_STATE_NAMESPACE = "reminder-runtime-v2";
const REMINDER_RUN_TTL_MS = 2 * 60 * 1000;
const REMINDER_RUN_FRESH_MS = 30 * 1000;
const REMINDER_RUN_WAIT_MS = 3 * 1000;
const REMINDER_RUN_POLL_MS = 25;

function dispatcherProjectionKey(jobId: string): string {
  return `dispatcher:${jobId}`;
}

function runProjectionKey(jobId: string): string {
  return `run:${jobId}`;
}

function requireReminderStateStore(): ReminderStateStore {
  if (!reminderStateStore) {
    throw new Error("Reminder scheduler projection is unavailable or stale");
  }
  return reminderStateStore;
}

function resolveExpectedReminderRecipient(config: unknown): string {
  const root = config && typeof config === "object" && !Array.isArray(config) ? config as JsonRecord : null;
  const channels = root?.channels && typeof root.channels === "object" && !Array.isArray(root.channels) ? root.channels as JsonRecord : null;
  const telegram = channels?.telegram && typeof channels.telegram === "object" && !Array.isArray(channels.telegram) ? channels.telegram as JsonRecord : null;
  const accounts = telegram?.accounts && typeof telegram.accounts === "object" && !Array.isArray(telegram.accounts) ? telegram.accounts as JsonRecord : null;
  const tasks = accounts?.[REMINDER_ACCOUNT_ID] && typeof accounts[REMINDER_ACCOUNT_ID] === "object" && !Array.isArray(accounts[REMINDER_ACCOUNT_ID])
    ? accounts[REMINDER_ACCOUNT_ID] as JsonRecord : null;
  const allowFrom = tasks?.allowFrom;
  if (!Array.isArray(allowFrom) || allowFrom.length !== 1) {
    throw new Error("Reminder delivery requires exactly one tasks Telegram owner");
  }
  const recipient = String(allowFrom[0] ?? "").trim();
  if (!recipient) throw new Error("Reminder delivery owner is invalid");
  return recipient;
}

function validateReminderJob(job: SchedulerJob, expectedRecipient: string): SchedulerJob {
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
  if (
    job.payload?.kind !== "script" ||
    job.payload.script !== buildReminderDispatchScript() ||
    JSON.stringify(job.payload.toolsAllow ?? []) !== JSON.stringify([TASK_REMINDER_DISPATCH_TOOL])
  ) {
    throw new Error("Reminder dispatcher payload drift detected");
  }
  if (
    job.delivery?.mode !== "announce" ||
    job.delivery.channel !== REMINDER_CHANNEL_ID ||
    job.delivery.accountId !== REMINDER_ACCOUNT_ID ||
    job.delivery.to !== expectedRecipient ||
    (job.delivery.bestEffort !== undefined && job.delivery.bestEffort !== false)
  ) {
    throw new Error("Reminder dispatcher delivery route drift detected");
  }
  return job;
}

async function findReminderJob(service: SchedulerService, jobId: string, expectedRecipient: string): Promise<SchedulerJob | null> {
  const jobs = await service.list({ includeDisabled: true });
  const matches = jobs.filter((job) => job.id === jobId);
  if (matches.length !== 1) return null;
  const job = matches[0]!;
  if (job.declarationKey !== REMINDER_DISPATCH_DECLARATION) return null;
  return validateReminderJob(job, expectedRecipient);
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

function isFreshRunProjection(value: ReminderStateValue | undefined, jobId: string, nowMs: number): value is RunProjection {
  if (!value || value.kind !== "run" || value.jobId !== jobId) return false;
  if (!Number.isFinite(value.runAtMs) || !Number.isFinite(value.projectedAtMs)) return false;
  const runAge = nowMs - value.runAtMs;
  const projectionAge = nowMs - value.projectedAtMs;
  return runAge >= -1_000 && runAge <= REMINDER_RUN_FRESH_MS && projectionAge >= -1_000 && projectionAge <= REMINDER_RUN_FRESH_MS;
}

async function waitForRunProjection(
  store: ReminderStateStore,
  jobId: string,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void>; waitMs?: number } = {},
): Promise<RunProjection> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.waitMs ?? REMINDER_RUN_WAIT_MS);
  do {
    const currentNow = now();
    const projection = await store.lookup(runProjectionKey(jobId));
    if (isFreshRunProjection(projection, jobId, currentNow)) return projection;
    if (currentNow >= deadline) break;
    await sleep(REMINDER_RUN_POLL_MS);
  } while (true);
  throw new Error("Reminder scheduler projection is unavailable or stale");
}

async function refreshDispatcherProjection(
  jobId: string,
  context: { config?: unknown; getCron?: () => unknown },
  apiConfig: unknown,
  store: ReminderStateStore,
): Promise<SchedulerJob | null> {
  const key = dispatcherProjectionKey(jobId);
  try {
    const service = context.getCron?.() as SchedulerService | undefined;
    if (!service) throw new Error("Reminder scheduler is unavailable");
    const expectedRecipient = resolveExpectedReminderRecipient(context.config ?? apiConfig);
    const job = await findReminderJob(service, jobId, expectedRecipient);
    if (!job) throw new Error("Reminder dispatcher is not registered");
    await store.register(key, { kind: "dispatcher", jobId, expectedRecipient });
    return job;
  } catch {
    await store.delete(key);
    return null;
  }
}

async function projectStartedRun(
  event: { action: string; jobId: string; runAtMs?: number },
  context: { config?: unknown; getCron?: () => unknown },
  apiConfig: unknown,
  store: ReminderStateStore,
  now: () => number = Date.now,
): Promise<boolean> {
  if (event.action !== "started" || typeof event.runAtMs !== "number" || !Number.isFinite(event.runAtMs)) return false;
  const job = await refreshDispatcherProjection(event.jobId, context, apiConfig, store);
  if (!job || runningAtMs(job) !== event.runAtMs) {
    await store.delete(runProjectionKey(event.jobId));
    return false;
  }
  const dispatcher = await store.lookup(dispatcherProjectionKey(event.jobId));
  if (!dispatcher || dispatcher.kind !== "dispatcher") {
    await store.delete(runProjectionKey(event.jobId));
    return false;
  }
  await store.register(runProjectionKey(event.jobId), {
    kind: "run",
    jobId: event.jobId,
    runAtMs: event.runAtMs,
    expectedRecipient: dispatcher.expectedRecipient,
    projectedAtMs: now(),
  }, { ttlMs: REMINDER_RUN_TTL_MS });
  return true;
}

export function buildReminderDispatchScript(): string {
  return [
    `const dispatch = await ${TASK_REMINDER_DISPATCH_TOOL}({});`,
    "json(dispatch.count > 0 ? { notify: dispatch.message } : {});",
  ].join("\n");
}

export async function executeReminderDispatch(
  toolContext: OpenClawPluginToolContext,
  deps: {
    signal?: AbortSignal;
    store?: ReminderStateStore;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    waitMs?: number;
  } = {},
): Promise<JsonRecord> {
  const jobId = parseCurrentCronJobId(toolContext.sessionKey, toolContext.agentId);
  if (!jobId) throw new Error(`${TASK_REMINDER_DISPATCH_TOOL} is available only to a tasks cron session`);
  const store = deps.store ?? requireReminderStateStore();
  const projection = await waitForRunProjection(store, jobId, { now: deps.now, sleep: deps.sleep, waitMs: deps.waitMs });
  const dispatcher = await store.lookup(dispatcherProjectionKey(jobId));
  if (!dispatcher || dispatcher.kind !== "dispatcher" || dispatcher.expectedRecipient !== projection.expectedRecipient) {
    throw new Error(`${TASK_REMINDER_DISPATCH_TOOL} is available only to the registered Reminder dispatcher`);
  }
  const runtimeConfig = (toolContext as OpenClawPluginToolContext & { runtimeConfig?: unknown; config?: unknown }).runtimeConfig
    ?? (toolContext as OpenClawPluginToolContext & { config?: unknown }).config;
  if (runtimeConfig !== undefined && resolveExpectedReminderRecipient(runtimeConfig) !== projection.expectedRecipient) {
    throw new Error("Reminder dispatcher delivery route drift detected");
  }
  const result = requireSuccessfulTaskctl(await runReminderInternal("dispatch", {
    claim_token: claimToken(jobId, projection.runAtMs),
    boundary: new Date(projection.runAtMs).toISOString(),
  }, { signal: deps.signal }), "Reminder dispatch");
  if (!Number.isSafeInteger(result.count) || Number(result.count) < 0 || typeof result.message !== "string") {
    throw new Error("Reminder dispatch returned an invalid result");
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
  deps: { store?: ReminderStateStore; now?: () => number } = {},
) {
  const jobId = parseCurrentCronJobId(event.sessionKey ?? context.sessionKey);
  if (!jobId) return undefined;
  const store = deps.store ?? requireReminderStateStore();
  const run = await store.lookup(runProjectionKey(jobId));
  if (!run || run.kind !== "run") return undefined;
  const dispatcher = await store.lookup(dispatcherProjectionKey(jobId));
  if (!dispatcher || dispatcher.kind !== "dispatcher" || dispatcher.expectedRecipient !== run.expectedRecipient ||
      !isFreshRunProjection(run, jobId, (deps.now ?? Date.now)())) {
    return { cancel: true, reason: "reminder_pre_send_revalidation_failed" };
  }
  if (context.channelId !== REMINDER_CHANNEL_ID || context.accountId !== REMINDER_ACCOUNT_ID) {
    return { cancel: true, reason: "reminder_delivery_route_mismatch" };
  }
  try {
    const rendered = requireSuccessfulTaskctl(
      await runReminderInternal("render", { claim_token: claimToken(jobId, run.runAtMs) }),
      "Reminder pre-send render",
    );
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

async function handleCronChanged(
  event: {
    action: string;
    jobId: string;
    runAtMs?: number;
    completionStatus?: string;
    delivered?: boolean;
    deliveryStatus?: string;
  },
  context: { config?: unknown; getCron?: () => unknown } = {},
  deps: { store?: ReminderStateStore; apiConfig?: unknown; now?: () => number } = {},
) {
  const store = deps.store ?? requireReminderStateStore();
  if (event.action === "started") {
    await projectStartedRun(event, context, deps.apiConfig, store, deps.now);
    return;
  }
  if (event.action === "added" || event.action === "updated" || event.action === "scheduled") {
    await refreshDispatcherProjection(event.jobId, context, deps.apiConfig, store);
    return;
  }
  if (event.action === "removed") {
    await store.delete(dispatcherProjectionKey(event.jobId));
    await store.delete(runProjectionKey(event.jobId));
    return;
  }
  if (event.action !== "finished" || typeof event.runAtMs !== "number" || !Number.isFinite(event.runAtMs)) return;
  const run = await store.lookup(runProjectionKey(event.jobId));
  const dispatcher = await store.lookup(dispatcherProjectionKey(event.jobId));
  if (!run || run.kind !== "run" || run.runAtMs !== event.runAtMs || !dispatcher ||
      dispatcher.kind !== "dispatcher" || dispatcher.expectedRecipient !== run.expectedRecipient) return;
  const token = claimToken(event.jobId, event.runAtMs);
  const delivered = event.completionStatus === "succeeded" && event.delivered === true && event.deliveryStatus === "delivered";
  try {
    await runReminderInternal("settle", { claim_token: token, delivered });
  } finally {
    await store.delete(runProjectionKey(event.jobId));
  }
}

async function handleCronReconciled(
  event: { enabled: boolean },
  context: { config?: unknown; getCron?: () => unknown },
  apiConfig: unknown,
  store: ReminderStateStore,
): Promise<void> {
  await store.clear();
  if (!event.enabled) return;
  try {
    const service = context.getCron?.() as SchedulerService | undefined;
    if (!service) return;
    const expectedRecipient = resolveExpectedReminderRecipient(context.config ?? apiConfig);
    const jobs = await service.list({ includeDisabled: true });
    const matches = jobs.filter((job) => job.declarationKey === REMINDER_DISPATCH_DECLARATION);
    if (matches.length !== 1) return;
    const job = validateReminderJob(matches[0]!, expectedRecipient);
    await store.register(dispatcherProjectionKey(job.id), { kind: "dispatcher", jobId: job.id, expectedRecipient });
  } catch {
    await store.clear();
  }
}

export function registerReminderRuntime(api: OpenClawPluginApi): void {
  const store = api.runtime.state.openKeyedStore<ReminderStateValue>({
    namespace: REMINDER_STATE_NAMESPACE,
    maxEntries: 16,
    overflowPolicy: "reject-new",
  }) as ReminderStateStore;
  reminderStateStore = store;
  api.on("cron_reconciled", (event, context) => handleCronReconciled(event, context, api.config, store));
  api.on("reply_payload_sending", (event, context) => handleReplyPayloadSending(event as never, context, { store }));
  api.on("cron_changed", (event, context) => handleCronChanged(event, context, { store, apiConfig: api.config }));
  api.on("gateway_stop", async () => {
    try {
      await store.clear();
    } finally {
      if (reminderStateStore === store) reminderStateStore = undefined;
    }
  });
}

export const reminderRuntimeInternals = {
  parseCurrentCronJobId,
  claimToken,
  resolveExpectedReminderRecipient,
  validateReminderJob,
  findReminderJob,
  isFreshRunProjection,
  waitForRunProjection,
  refreshDispatcherProjection,
  projectStartedRun,
  handleReplyPayloadSending,
  handleCronChanged,
  handleCronReconciled,
  dispatcherProjectionKey,
  runProjectionKey,
  resetLocalState: () => { reminderStateStore = undefined; },
};
