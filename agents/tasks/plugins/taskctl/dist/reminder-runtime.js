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
let schedulerGeneration;
let schedulerServiceBinding;
const activeClaims = new Map();
const knownReminderJobIds = new Set();
function parseCurrentCronJobId(sessionKey, agentId) {
    if (agentId !== undefined && agentId !== REMINDER_AGENT_ID)
        return null;
    if (!sessionKey)
        return null;
    return /^agent:tasks:cron:([^:]+):trigger$/.exec(sessionKey)?.[1] ?? null;
}
function claimToken(jobId, runAtMs) {
    if (!jobId.trim() || !Number.isFinite(runAtMs))
        throw new Error("Reminder run identity is invalid");
    return `reminder:${jobId}:${Math.trunc(runAtMs)}`;
}
function requireSchedulerGeneration() {
    const serviceBinding = schedulerServiceBinding;
    if (serviceBinding) {
        try {
            const service = serviceBinding.getService();
            if (service && serviceBinding.expectedRecipient) {
                return { service, expectedRecipient: serviceBinding.expectedRecipient };
            }
        }
        catch {
            // A revoked service-bound scheduler must fail closed rather than fall back
            // to a potentially stale cron_reconciled snapshot.
        }
        throw new Error("Reminder scheduler projection is unavailable or stale");
    }
    const generation = schedulerGeneration;
    if (!generation || generation.abortSignal?.aborted) {
        throw new Error("Reminder scheduler projection is unavailable or stale");
    }
    return generation;
}
function resolveExpectedReminderRecipient(config) {
    const root = config && typeof config === "object" && !Array.isArray(config) ? config : null;
    const channels = root?.channels && typeof root.channels === "object" && !Array.isArray(root.channels) ? root.channels : null;
    const telegram = channels?.telegram && typeof channels.telegram === "object" && !Array.isArray(channels.telegram) ? channels.telegram : null;
    const accounts = telegram?.accounts && typeof telegram.accounts === "object" && !Array.isArray(telegram.accounts) ? telegram.accounts : null;
    const tasks = accounts?.[REMINDER_ACCOUNT_ID] && typeof accounts[REMINDER_ACCOUNT_ID] === "object" && !Array.isArray(accounts[REMINDER_ACCOUNT_ID])
        ? accounts[REMINDER_ACCOUNT_ID] : null;
    const allowFrom = tasks?.allowFrom;
    if (!Array.isArray(allowFrom) || allowFrom.length !== 1) {
        throw new Error("Reminder delivery requires exactly one tasks Telegram owner");
    }
    const recipient = String(allowFrom[0] ?? "").trim();
    if (!recipient)
        throw new Error("Reminder delivery owner is invalid");
    return recipient;
}
function validateReminderJob(job, expectedRecipient) {
    if (job.declarationKey !== REMINDER_DISPATCH_DECLARATION) {
        throw new Error("Reminder dispatcher cron identity mismatch");
    }
    if (job.enabled !== true || job.agentId !== REMINDER_AGENT_ID || job.sessionTarget !== "isolated") {
        throw new Error("Reminder dispatcher must run as enabled isolated tasks agent");
    }
    if (job.schedule?.kind !== "cron" ||
        job.schedule.expr !== REMINDER_DISPATCH_CRON ||
        job.schedule.tz !== REMINDER_TIMEZONE ||
        (job.schedule.staggerMs !== undefined && job.schedule.staggerMs !== 0)) {
        throw new Error("Reminder dispatcher schedule drift detected");
    }
    if (job.payload?.kind !== "script" ||
        job.payload.script !== buildReminderDispatchScript() ||
        JSON.stringify(job.payload.toolsAllow ?? []) !== JSON.stringify([TASK_REMINDER_DISPATCH_TOOL])) {
        throw new Error("Reminder dispatcher payload drift detected");
    }
    if (job.delivery?.mode !== "announce" ||
        job.delivery.channel !== REMINDER_CHANNEL_ID ||
        job.delivery.accountId !== REMINDER_ACCOUNT_ID ||
        job.delivery.to !== expectedRecipient ||
        (job.delivery.bestEffort !== undefined && job.delivery.bestEffort !== false)) {
        throw new Error("Reminder dispatcher delivery route drift detected");
    }
    return job;
}
async function findReminderJob(service, jobId, expectedRecipient) {
    const jobs = await service.list({ includeDisabled: true });
    const matches = jobs.filter((job) => job.id === jobId);
    if (matches.length !== 1)
        return null;
    const job = matches[0];
    if (job.declarationKey !== REMINDER_DISPATCH_DECLARATION)
        return null;
    return validateReminderJob(job, expectedRecipient);
}
function requireObject(value, label) {
    if (!value || Array.isArray(value) || typeof value !== "object")
        throw new Error(`${label} must be an object`);
    return value;
}
function requireSuccessfulTaskctl(value, label) {
    const record = requireObject(value, label);
    if (record.ok !== true) {
        const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
            ? record.error : null;
        throw new Error(`${label} failed: ${typeof error?.message === "string" ? error.message : "unknown error"}`);
    }
    return record;
}
function runningAtMs(job) {
    const value = job.state?.runningAtMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("Reminder dispatcher has no current runningAtMs");
    }
    return value;
}
export function buildReminderDispatchScript() {
    return [
        `const dispatch = await ${TASK_REMINDER_DISPATCH_TOOL}({});`,
        "json(dispatch.count > 0 ? { notify: dispatch.message } : {});",
    ].join("\n");
}
export async function executeReminderDispatch(toolContext, deps = {}) {
    const jobId = parseCurrentCronJobId(toolContext.sessionKey, toolContext.agentId);
    if (!jobId)
        throw new Error(`${TASK_REMINDER_DISPATCH_TOOL} is available only to a tasks cron session`);
    const generation = requireSchedulerGeneration();
    const job = await findReminderJob(generation.service, jobId, generation.expectedRecipient);
    if (!job)
        throw new Error(`${TASK_REMINDER_DISPATCH_TOOL} is available only to the registered Reminder dispatcher`);
    generation.abortSignal?.throwIfAborted();
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
export function createReminderDispatchTool(toolContext) {
    if (!parseCurrentCronJobId(toolContext.sessionKey, toolContext.agentId))
        return null;
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
async function handleReplyPayloadSending(event, context) {
    const jobId = parseCurrentCronJobId(event.sessionKey ?? context.sessionKey);
    if (!jobId)
        return undefined;
    const claims = activeClaims.get(jobId) ?? [];
    if (claims.length === 0)
        return undefined;
    const claim = claims.length === 1 ? claims[0] : undefined;
    if (!claim)
        return { cancel: true, reason: "reminder_claim_identity_ambiguous" };
    try {
        const generation = requireSchedulerGeneration();
        const job = await findReminderJob(generation.service, jobId, generation.expectedRecipient);
        if (!job)
            return { cancel: true, reason: "reminder_dispatcher_drift" };
        if (context.channelId !== REMINDER_CHANNEL_ID || context.accountId !== REMINDER_ACCOUNT_ID) {
            return { cancel: true, reason: "reminder_delivery_route_mismatch" };
        }
        const rendered = requireSuccessfulTaskctl(await runReminderInternal("render", { claim_token: claim.token }), "Reminder pre-send render");
        const count = Number(rendered.count);
        const message = rendered.message;
        if (!Number.isSafeInteger(count) || count < 0 || typeof message !== "string") {
            return { cancel: true, reason: "reminder_render_invalid" };
        }
        if (count === 0 || !message.trim())
            return { cancel: true, reason: "reminder_claim_no_longer_active" };
        return { payload: { ...event.payload, text: message } };
    }
    catch {
        return { cancel: true, reason: "reminder_pre_send_revalidation_failed" };
    }
}
async function handleCronChanged(event) {
    if (event.action !== "finished" || typeof event.runAtMs !== "number" || !Number.isFinite(event.runAtMs))
        return;
    if (!knownReminderJobIds.has(event.jobId))
        return;
    const token = claimToken(event.jobId, event.runAtMs);
    const delivered = event.completionStatus === "succeeded" && event.delivered === true && event.deliveryStatus === "delivered";
    try {
        await runReminderInternal("settle", { claim_token: token, delivered });
    }
    finally {
        const remaining = (activeClaims.get(event.jobId) ?? []).filter((claim) => claim.token !== token);
        if (remaining.length)
            activeClaims.set(event.jobId, remaining);
        else
            activeClaims.delete(event.jobId);
    }
}
export function registerReminderRuntime(api) {
    api.registerService({
        id: "taskctl-reminder-scheduler-access",
        start: (context) => {
            const serviceContext = context;
            const getService = serviceContext.getCron;
            if (!getService) {
                schedulerServiceBinding = undefined;
                return;
            }
            try {
                schedulerServiceBinding = {
                    getService,
                    expectedRecipient: resolveExpectedReminderRecipient(context.config),
                };
            }
            catch {
                // Presence of the service-bound scheduler is authoritative on hosts that
                // expose it. Keep the binding so an invalid current delivery owner fails
                // closed instead of falling back to an older cron_reconciled snapshot.
                schedulerServiceBinding = { getService };
            }
        },
        stop: () => {
            schedulerServiceBinding = undefined;
            activeClaims.clear();
            knownReminderJobIds.clear();
        },
    });
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
        try {
            schedulerGeneration = {
                service: service,
                abortSignal: context.abortSignal,
                expectedRecipient: resolveExpectedReminderRecipient(api.config),
            };
        }
        catch {
            schedulerGeneration = undefined;
        }
    });
    api.on("reply_payload_sending", (event, context) => handleReplyPayloadSending(event, context));
    api.on("cron_changed", (event) => handleCronChanged(event));
    api.on("gateway_stop", () => { schedulerGeneration = undefined; activeClaims.clear(); knownReminderJobIds.clear(); });
}
export const reminderRuntimeInternals = {
    parseCurrentCronJobId,
    claimToken,
    resolveExpectedReminderRecipient,
    validateReminderJob,
    findReminderJob,
    handleReplyPayloadSending,
    handleCronChanged,
    resetState: () => { schedulerGeneration = undefined; schedulerServiceBinding = undefined; activeClaims.clear(); knownReminderJobIds.clear(); },
    activeClaims,
    knownReminderJobIds,
};
