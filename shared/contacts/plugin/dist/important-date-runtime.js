import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { runImportantDateInternal } from "./index.js";
import { beginImportantDateProjectedRun, finishImportantDateProjectedRun, importantDateProjectionPath, readImportantDateProjection, reconcileImportantDateProjection, removeImportantDateProjection, } from "./important-date-projection.js";
export const CONTACT_DATE_REMINDER_DISPATCH_TOOL = "contact_date_reminder_dispatch";
export const IMPORTANT_DATE_DISPATCH_DECLARATION = "contacts.important-dates.dispatch.v1";
export const IMPORTANT_DATE_DISPATCH_NAME = "contacts-important-dates-dispatch";
export const IMPORTANT_DATE_DISPATCH_CRON = "0 9 * * *";
export const IMPORTANT_DATE_TIMEZONE = "Europe/Moscow";
const AGENT_ID = "main";
const ACCOUNT_ID = "default";
const CHANNEL_ID = "telegram";
const ACTIVE_RUN_MAX_AGE_MS = 5 * 60 * 1000;
const ACTIVE_RUN_FUTURE_TOLERANCE_MS = 30 * 1000;
const ACTIVE_RUN_WAIT_MS = 2_000;
const ACTIVE_RUN_POLL_MS = 25;
const STATIC_RECONCILIATION_HINTS = new Set(["added", "updated", "removed", "scheduled"]);
export const importantDateDispatchParameters = Type.Object({}, { additionalProperties: false });
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
async function findRegisteredJob(service, expectedRecipient) {
    const jobs = await service.list({ includeDisabled: true });
    const matches = jobs.filter(job => job.declarationKey === IMPORTANT_DATE_DISPATCH_DECLARATION);
    if (matches.length !== 1)
        throw new Error(`Important Dates requires exactly one registered dispatcher; found ${matches.length}`);
    return validateJob(matches[0], expectedRecipient);
}
function projectJob(job) {
    return {
        id: job.id,
        declarationKey: job.declarationKey,
        agentId: job.agentId,
        enabled: job.enabled,
        schedule: { kind: job.schedule.kind, expr: job.schedule.expr, tz: job.schedule.tz, ...(job.schedule.staggerMs === undefined ? {} : { staggerMs: job.schedule.staggerMs }) },
        sessionTarget: job.sessionTarget,
        payload: { kind: job.payload.kind, script: job.payload.script, toolsAllow: [...(job.payload.toolsAllow ?? [])] },
        delivery: { mode: job.delivery.mode, channel: job.delivery.channel, accountId: job.delivery.accountId, to: job.delivery.to, ...(job.delivery.bestEffort === undefined ? {} : { bestEffort: job.delivery.bestEffort }) },
    };
}
function validateActiveProjection(projection, jobId, nowMs) {
    validateJob(projection.job, projection.expectedRecipient);
    if (projection.job.id !== jobId)
        throw new Error("Important Dates dispatcher identity mismatch");
    const active = projection.activeRun;
    if (!active)
        throw new Error("Important Dates scheduler projection has no active run");
    if (active.recordedAtMs > nowMs + ACTIVE_RUN_FUTURE_TOLERANCE_MS || nowMs - active.recordedAtMs > ACTIVE_RUN_MAX_AGE_MS)
        throw new Error("Important Dates scheduler projection is stale");
    if (active.runAtMs > nowMs + ACTIVE_RUN_FUTURE_TOLERANCE_MS || nowMs - active.runAtMs > ACTIVE_RUN_MAX_AGE_MS)
        throw new Error("Important Dates scheduler run boundary is stale");
    return projection;
}
async function requireActiveProjection(jobId, options = {}) {
    return validateActiveProjection(await readImportantDateProjection(options.path), jobId, options.nowMs ?? Date.now());
}
function projectionMayStillArrive(error) {
    if (error?.code === "ENOENT")
        return true;
    const message = String(error?.message ?? error);
    return message.includes("has no active run") || message.includes("projection is stale") || message.includes("run boundary is stale");
}
async function waitForActiveProjection(jobId, options = {}) {
    const waitMs = options.waitMs ?? ACTIVE_RUN_WAIT_MS;
    const pollMs = options.pollMs ?? ACTIVE_RUN_POLL_MS;
    const deadline = Date.now() + Math.max(0, waitMs);
    while (true) {
        options.signal?.throwIfAborted();
        try {
            return await requireActiveProjection(jobId, { path: options.path, nowMs: options.nowMs });
        }
        catch (error) {
            if (!projectionMayStillArrive(error) || Date.now() >= deadline)
                throw error;
        }
        if (options.signal)
            await sleep(Math.max(1, pollMs), undefined, { signal: options.signal });
        else
            await sleep(Math.max(1, pollMs));
    }
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
    const projection = await waitForActiveProjection(jobId, { path: deps.path, nowMs: deps.nowMs, signal: deps.signal, waitMs: deps.waitMs, pollMs: deps.pollMs });
    const runAtMs = projection.activeRun.runAtMs, token = claimToken(jobId, runAtMs);
    const result = requireSuccessful(await runImportantDateInternal("date_dispatch", { claim_token: token, boundary: new Date(runAtMs).toISOString() }, { signal: deps.signal }), "Important Dates dispatch");
    if (!Number.isSafeInteger(result.count) || Number(result.count) < 0 || typeof result.message !== "string")
        throw new Error("Important Dates dispatch returned an invalid result");
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
async function handleReplyPayloadSending(event, context, options = {}) {
    const jobId = parseCurrentJobId(event.sessionKey ?? context.sessionKey);
    if (!jobId)
        return undefined;
    try {
        const projection = await requireActiveProjection(jobId, options);
        if (context.channelId !== CHANNEL_ID || context.accountId !== ACCOUNT_ID)
            return { cancel: true, reason: "important_date_delivery_route_mismatch" };
        const token = claimToken(jobId, projection.activeRun.runAtMs);
        const rendered = requireSuccessful(await runImportantDateInternal("date_render", { claim_token: token }), "Important Dates pre-send render");
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
async function settleFinishedRun(event, path) {
    if (event.action !== "finished" || typeof event.runAtMs !== "number" || !Number.isFinite(event.runAtMs))
        return;
    let projection;
    try {
        projection = await readImportantDateProjection(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    if (projection.job.id !== event.jobId || projection.activeRun?.runAtMs !== event.runAtMs)
        return;
    const token = claimToken(event.jobId, event.runAtMs);
    const delivered = event.completionStatus === "succeeded" && event.delivered === true && event.deliveryStatus === "delivered";
    try {
        await runImportantDateInternal("date_settle", { claim_token: token, delivered });
    }
    finally {
        await finishImportantDateProjectedRun({ path, jobId: event.jobId, runAtMs: event.runAtMs });
    }
}
export function registerImportantDateRuntime(api) {
    let statePath;
    let getCurrentCron;
    const currentPath = () => statePath ?? importantDateProjectionPath();
    const refresh = async (service, path, signal) => {
        signal?.throwIfAborted();
        const expectedRecipient = resolveExpectedRecipient(api.config);
        const job = await findRegisteredJob(service, expectedRecipient);
        signal?.throwIfAborted();
        await reconcileImportantDateProjection({ path, expectedRecipient, job: projectJob(job), signal });
        return job;
    };
    const refreshCurrent = async (path) => {
        try {
            const service = getCurrentCron?.();
            if (!service) {
                await removeImportantDateProjection(path);
                return null;
            }
            return await refresh(service, path);
        }
        catch {
            await removeImportantDateProjection(path);
            return null;
        }
    };
    if (typeof api.registerService === "function")
        api.registerService({
            id: "contacts-important-date-projection",
            start: async (context) => {
                statePath = importantDateProjectionPath(context.stateDir);
                getCurrentCron = () => context.getCron?.();
                const service = getCurrentCron();
                if (!service)
                    throw new Error("Important Dates projection initialization requires native Automation access");
                await refresh(service, statePath);
            },
            stop: () => { getCurrentCron = undefined; statePath = undefined; },
        });
    api.on("cron_reconciled", async (event, context) => {
        const path = currentPath(), signal = context.abortSignal;
        signal?.throwIfAborted();
        if (!event.enabled) {
            await removeImportantDateProjection(path, signal);
            return;
        }
        const service = context.getCron?.();
        if (!service) {
            await removeImportantDateProjection(path, signal);
            return;
        }
        try {
            await refresh(service, path, signal);
        }
        catch {
            signal?.throwIfAborted();
            await removeImportantDateProjection(path, signal);
        }
    });
    api.on("reply_payload_sending", (event, context) => handleReplyPayloadSending(event, context, { path: currentPath() }));
    api.on("cron_changed", async (event) => {
        const change = event, path = currentPath();
        if (change.action === "finished") {
            await settleFinishedRun(change, path);
            return;
        }
        if (STATIC_RECONCILIATION_HINTS.has(change.action)) {
            await refreshCurrent(path);
            return;
        }
        if (change.action !== "started")
            return;
        if (typeof change.runAtMs !== "number" || !Number.isFinite(change.runAtMs))
            throw new Error("Important Dates dispatcher started without a run boundary");
        const job = await refreshCurrent(path);
        if (!job || job.id !== change.jobId)
            return;
        await beginImportantDateProjectedRun({ path, jobId: change.jobId, runAtMs: change.runAtMs });
    });
}
export const importantDateRuntimeInternals = {
    parseCurrentJobId, claimToken, resolveExpectedRecipient, validateJob, findRegisteredJob, projectJob, validateActiveProjection, waitForActiveProjection, handleReplyPayloadSending, settleFinishedRun,
};
