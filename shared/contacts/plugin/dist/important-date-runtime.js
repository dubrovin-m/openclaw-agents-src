import { Type } from "typebox";
import { runImportantDateInternal } from "./index.js";
export const CONTACT_DATE_REMINDER_DISPATCH_TOOL = "contact_date_reminder_dispatch";
export const IMPORTANT_DATE_DISPATCH_DECLARATION = "contacts.important-dates.dispatch.v1";
export const IMPORTANT_DATE_DISPATCH_NAME = "contacts-important-dates-dispatch";
export const IMPORTANT_DATE_DISPATCH_CRON = "0 9 * * *";
export const IMPORTANT_DATE_TIMEZONE = "Europe/Moscow";
const AGENT_ID = "main";
const ACCOUNT_ID = "default";
const CHANNEL_ID = "telegram";
export const importantDateDispatchParameters = Type.Object({}, { additionalProperties: false });
let schedulerGeneration;
const activeClaims = new Map();
const knownJobIds = new Set();
function parseCurrentJobId(sessionKey, agentId) {
    if (agentId !== undefined && agentId !== AGENT_ID)
        return null;
    if (!sessionKey)
        return null;
    return /^agent:main:cron:([^:]+):trigger$/.exec(sessionKey)?.[1] ?? null;
}
function claimToken(jobId, runAtMs) {
    if (!jobId.trim() || !Number.isFinite(runAtMs))
        throw new Error("Important Dates run identity is invalid");
    return `important-date:${jobId}:${Math.trunc(runAtMs)}`;
}
function requireSchedulerGeneration() {
    const generation = schedulerGeneration;
    if (!generation || generation.abortSignal.aborted)
        throw new Error("Important Dates scheduler projection is unavailable or stale");
    return generation;
}
function requireObject(value, label) {
    if (!value || Array.isArray(value) || typeof value !== "object")
        throw new Error(`${label} must be an object`);
    return value;
}
function requireSuccessful(value, label) {
    const record = requireObject(value, label);
    if (record.ok !== true) {
        const error = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error : null;
        throw new Error(`${label} failed: ${typeof error?.message === "string" ? error.message : "unknown error"}`);
    }
    return record;
}
function resolveExpectedRecipient(config) {
    const root = config && typeof config === "object" && !Array.isArray(config) ? config : null;
    const commands = root?.commands && typeof root.commands === "object" && !Array.isArray(root.commands) ? root.commands : null;
    const allow = commands?.ownerAllowFrom;
    if (!Array.isArray(allow) || allow.length !== 1)
        throw new Error("Important Dates delivery requires exactly one ownerAllowFrom entry");
    const ownerRoute = String(allow[0] ?? "").trim();
    const match = /^telegram:([1-9]\d*)$/.exec(ownerRoute);
    if (!match)
        throw new Error("Important Dates owner route must be one telegram:<id> target");
    const recipient = match[1];
    const channels = root?.channels && typeof root.channels === "object" && !Array.isArray(root.channels) ? root.channels : null;
    const telegram = channels?.telegram && typeof channels.telegram === "object" && !Array.isArray(channels.telegram) ? channels.telegram : null;
    if (telegram?.enabled !== true)
        throw new Error("Telegram must be enabled for Important Dates delivery");
    const bindings = Array.isArray(root?.bindings) ? root.bindings : [];
    const matches = bindings.filter((x) => {
        const match = x?.match && typeof x.match === "object" && !Array.isArray(x.match) ? x.match : null;
        return x?.agentId === AGENT_ID && match?.channel === CHANNEL_ID && match?.accountId === ACCOUNT_ID;
    });
    if (matches.length !== 1)
        throw new Error("Important Dates delivery requires exactly one main/default Telegram binding");
    return recipient;
}
function validateJob(job, expectedRecipient) {
    if (job.declarationKey !== IMPORTANT_DATE_DISPATCH_DECLARATION)
        throw new Error("Important Dates dispatcher identity mismatch");
    if (job.enabled !== true || job.agentId !== AGENT_ID || job.sessionTarget !== "isolated")
        throw new Error("Important Dates dispatcher must run as enabled isolated main agent");
    if (job.schedule?.kind !== "cron" || job.schedule.expr !== IMPORTANT_DATE_DISPATCH_CRON || job.schedule.tz !== IMPORTANT_DATE_TIMEZONE || (job.schedule.staggerMs !== undefined && job.schedule.staggerMs !== 0))
        throw new Error("Important Dates dispatcher schedule drift detected");
    if (job.payload?.kind !== "script" || job.payload.script !== buildImportantDateDispatchScript() || JSON.stringify(job.payload.toolsAllow ?? []) !== JSON.stringify([CONTACT_DATE_REMINDER_DISPATCH_TOOL]))
        throw new Error("Important Dates dispatcher payload drift detected");
    if (job.delivery?.mode !== "announce" || job.delivery.channel !== CHANNEL_ID || job.delivery.accountId !== ACCOUNT_ID || job.delivery.to !== expectedRecipient || (job.delivery.bestEffort !== undefined && job.delivery.bestEffort !== false))
        throw new Error("Important Dates dispatcher delivery route drift detected");
    return job;
}
async function findJob(service, jobId, expectedRecipient) {
    const jobs = await service.list({ includeDisabled: true }), matches = jobs.filter(job => job.id === jobId);
    if (matches.length !== 1)
        return null;
    const job = matches[0];
    if (job.declarationKey !== IMPORTANT_DATE_DISPATCH_DECLARATION)
        return null;
    return validateJob(job, expectedRecipient);
}
function runningAtMs(job) {
    const value = job.state?.runningAtMs;
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error("Important Dates dispatcher has no current runningAtMs");
    return value;
}
export function buildImportantDateDispatchScript() {
    return [
        `const dispatch = await ${CONTACT_DATE_REMINDER_DISPATCH_TOOL}({});`,
        "json(dispatch.count > 0 ? { notify: dispatch.message } : {});",
    ].join("\n");
}
export async function executeImportantDateDispatch(toolContext, deps = {}) {
    const jobId = parseCurrentJobId(toolContext.sessionKey, toolContext.agentId);
    if (!jobId)
        throw new Error(`${CONTACT_DATE_REMINDER_DISPATCH_TOOL} is available only to a main cron session`);
    const generation = requireSchedulerGeneration(), job = await findJob(generation.service, jobId, generation.expectedRecipient);
    if (!job)
        throw new Error(`${CONTACT_DATE_REMINDER_DISPATCH_TOOL} is available only to the registered Important Dates dispatcher`);
    generation.abortSignal.throwIfAborted();
    const runAtMs = runningAtMs(job), token = claimToken(jobId, runAtMs);
    const result = requireSuccessful(await runImportantDateInternal("date_dispatch", { claim_token: token, boundary: new Date(runAtMs).toISOString() }, { signal: deps.signal }), "Important Dates dispatch");
    if (!Number.isSafeInteger(result.count) || Number(result.count) < 0 || typeof result.message !== "string")
        throw new Error("Important Dates dispatch returned an invalid result");
    knownJobIds.add(jobId);
    if (Number(result.count) > 0) {
        const claims = activeClaims.get(jobId) ?? [];
        if (!claims.some(claim => claim.token === token)) {
            claims.push({ token, runAtMs });
            activeClaims.set(jobId, claims);
        }
    }
    return result;
}
export function createImportantDateDispatchTool(toolContext) {
    if (!parseCurrentJobId(toolContext.sessionKey, toolContext.agentId))
        return null;
    return {
        name: CONTACT_DATE_REMINDER_DISPATCH_TOOL,
        label: "Important Dates Reminder Dispatcher",
        description: "Claim due ImportantDate reminders only inside the registered Contacts Automation run.",
        parameters: importantDateDispatchParameters,
        execute: async (_toolCallId, _params, signal) => {
            const result = await executeImportantDateDispatch(toolContext, { signal });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
    };
}
async function handleReplyPayloadSending(event, context) {
    const jobId = parseCurrentJobId(event.sessionKey ?? context.sessionKey);
    if (!jobId)
        return undefined;
    const claims = activeClaims.get(jobId) ?? [];
    if (claims.length === 0)
        return undefined;
    const claim = claims.length === 1 ? claims[0] : undefined;
    if (!claim)
        return { cancel: true, reason: "important_date_claim_identity_ambiguous" };
    try {
        const generation = requireSchedulerGeneration(), job = await findJob(generation.service, jobId, generation.expectedRecipient);
        if (!job)
            return { cancel: true, reason: "important_date_dispatcher_drift" };
        if (context.channelId !== CHANNEL_ID || context.accountId !== ACCOUNT_ID)
            return { cancel: true, reason: "important_date_delivery_route_mismatch" };
        const rendered = requireSuccessful(await runImportantDateInternal("date_render", { claim_token: claim.token }), "Important Dates pre-send render");
        const count = Number(rendered.count), message = rendered.message;
        if (!Number.isSafeInteger(count) || count < 0 || typeof message !== "string")
            return { cancel: true, reason: "important_date_render_invalid" };
        if (count === 0 || !message.trim())
            return { cancel: true, reason: "important_date_claim_no_longer_active" };
        return { payload: { ...event.payload, text: message } };
    }
    catch {
        return { cancel: true, reason: "important_date_pre_send_revalidation_failed" };
    }
}
async function handleCronChanged(event) {
    if (event.action !== "finished" || typeof event.runAtMs !== "number" || !Number.isFinite(event.runAtMs))
        return;
    if (!knownJobIds.has(event.jobId))
        return;
    const token = claimToken(event.jobId, event.runAtMs);
    const delivered = event.completionStatus === "succeeded" && event.delivered === true && event.deliveryStatus === "delivered";
    try {
        await runImportantDateInternal("date_settle", { claim_token: token, delivered });
    }
    finally {
        const remaining = (activeClaims.get(event.jobId) ?? []).filter(claim => claim.token !== token);
        if (remaining.length)
            activeClaims.set(event.jobId, remaining);
        else
            activeClaims.delete(event.jobId);
    }
}
export function registerImportantDateRuntime(api) {
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
            schedulerGeneration = { service: service, abortSignal: context.abortSignal, expectedRecipient: resolveExpectedRecipient(api.config) };
        }
        catch {
            schedulerGeneration = undefined;
        }
    });
    api.on("reply_payload_sending", (event, context) => handleReplyPayloadSending(event, context));
    api.on("cron_changed", (event) => handleCronChanged(event));
    api.on("gateway_stop", () => { schedulerGeneration = undefined; activeClaims.clear(); knownJobIds.clear(); });
}
export const importantDateRuntimeInternals = {
    parseCurrentJobId, claimToken, resolveExpectedRecipient, validateJob, findJob, handleReplyPayloadSending, handleCronChanged,
    resetState: () => { schedulerGeneration = undefined; activeClaims.clear(); knownJobIds.clear(); }, activeClaims, knownJobIds,
};
