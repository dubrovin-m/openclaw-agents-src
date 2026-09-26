import { DAILY_REVIEW_DECLARATIONS, TASK_DAILY_REVIEW_TOOL, buildDailyReviewScript, dailyReviewInternals, dailyReviewParameters, executeDailyReview, } from "./daily-review.js";
const DAILY_REVIEW_AGENT_ID = "tasks";
const DAILY_REVIEW_TIMEZONE = "Europe/Moscow";
const RECEIPT_TOKEN = "[taskctl.daily-review.receipt.v1";
const RECEIPT_RE = /(?:\n\n)?\[taskctl\.daily-review\.receipt\.v1 last_delivered_run_at=([^\]\s]+)\]$/;
const SYNTHETIC_ACTIVATION_VALIDATED_ROUTE = "task-daily-review-activation-validated-route";
let schedulerGeneration;
let schedulerServiceBinding;
function parseInstant(value, label) {
    const date = new Date(value);
    if (!value.trim() || Number.isNaN(date.getTime())) {
        throw new Error(`${label} must be a valid ISO timestamp`);
    }
    return { iso: date.toISOString(), ms: date.getTime() };
}
function assertProjectionActive(deps) {
    deps.abortSignal?.throwIfAborted();
    if (deps.isCurrent && !deps.isCurrent()) {
        throw new Error("Daily Review scheduler projection is stale");
    }
}
function parseReceipt(description) {
    const value = description ?? "";
    const markerIndex = value.indexOf(RECEIPT_TOKEN);
    if (markerIndex < 0) {
        return { baseDescription: value, lastDeliveredRunAtMs: null };
    }
    const match = RECEIPT_RE.exec(value);
    if (!match || value.indexOf(RECEIPT_TOKEN, markerIndex + RECEIPT_TOKEN.length) >= 0) {
        throw new Error("Daily Review Automation description contains malformed receipt metadata");
    }
    const parsed = parseInstant(match[1] ?? "", "Daily Review receipt timestamp");
    return {
        baseDescription: value.slice(0, match.index),
        lastDeliveredRunAtMs: parsed.ms,
    };
}
function withReceipt(baseDescription, runAtMs) {
    if (!Number.isFinite(runAtMs)) {
        throw new Error("Daily Review receipt timestamp must be finite");
    }
    const marker = `${RECEIPT_TOKEN} last_delivered_run_at=${new Date(runAtMs).toISOString()}]`;
    return baseDescription ? `${baseDescription}\n\n${marker}` : marker;
}
function visibleSuccessfulDelivery(job, boundaryMs, bootstrapMs) {
    const runAtMs = job.state?.lastRunAtMs;
    if (runAtMs === undefined)
        return null;
    if (!Number.isFinite(runAtMs) || runAtMs >= boundaryMs) {
        throw new Error(`Daily Review scheduler state for ${job.id} has invalid lastRunAtMs`);
    }
    if (job.state?.lastRunStatus !== "ok" ||
        job.state.lastDelivered !== true ||
        job.state.lastDeliveryStatus !== "delivered") {
        return null;
    }
    if (runAtMs < bootstrapMs)
        return null;
    return runAtMs;
}
function expectedSchedule(declarationKey) {
    if (declarationKey === DAILY_REVIEW_DECLARATIONS.morning) {
        return { declaration: DAILY_REVIEW_DECLARATIONS.morning, peer: DAILY_REVIEW_DECLARATIONS.evening, expr: "30 9 * * *" };
    }
    if (declarationKey === DAILY_REVIEW_DECLARATIONS.evening) {
        return { declaration: DAILY_REVIEW_DECLARATIONS.evening, peer: DAILY_REVIEW_DECLARATIONS.morning, expr: "0 17 * * *" };
    }
    throw new Error(`Unexpected Daily Review declarationKey: ${String(declarationKey)}`);
}
function validatePublicJob(job, label) {
    const expected = expectedSchedule(job.declarationKey);
    if (job.enabled !== true) {
        throw new Error(`${label} Daily Review job must be enabled`);
    }
    if (job.agentId !== DAILY_REVIEW_AGENT_ID || job.sessionTarget !== "isolated") {
        throw new Error(`${label} Daily Review job must run as isolated tasks agent`);
    }
    if (job.schedule?.kind !== "cron" ||
        job.schedule.expr !== expected.expr ||
        job.schedule.tz !== DAILY_REVIEW_TIMEZONE ||
        (job.schedule.staggerMs !== undefined && job.schedule.staggerMs !== 0)) {
        throw new Error(`${label} Daily Review schedule drift detected`);
    }
    if (job.payload?.kind !== "script") {
        throw new Error(`${label} Daily Review job must use a script payload`);
    }
    return expected;
}
function validatePair(jobs, currentJobId, peerJobId) {
    const declared = jobs.filter((job) => job.declarationKey === DAILY_REVIEW_DECLARATIONS.morning ||
        job.declarationKey === DAILY_REVIEW_DECLARATIONS.evening);
    if (declared.length !== 2) {
        throw new Error(`Daily Review requires exactly two declared schedule entries; found ${declared.length}`);
    }
    const currentMatches = declared.filter((job) => job.id === currentJobId);
    const peerMatches = declared.filter((job) => job.id === peerJobId);
    if (currentMatches.length !== 1 || peerMatches.length !== 1) {
        throw new Error("Daily Review current/peer schedule identity mismatch");
    }
    const current = currentMatches[0];
    const peer = peerMatches[0];
    const currentExpected = validatePublicJob(current, "current");
    const peerExpected = validatePublicJob(peer, "peer");
    if (currentExpected.peer !== peerExpected.declaration) {
        throw new Error("Daily Review jobs do not form the expected morning/evening pair");
    }
    return { current, peer };
}
async function promoteReceipt(params) {
    assertProjectionActive(params.deps);
    const parsed = parseReceipt(params.job.description);
    if (parsed.lastDeliveredRunAtMs !== null &&
        (parsed.lastDeliveredRunAtMs < params.bootstrapMs || parsed.lastDeliveredRunAtMs >= params.boundaryMs)) {
        throw new Error(`Daily Review receipt for ${params.job.id} is outside the active review window`);
    }
    const visible = visibleSuccessfulDelivery(params.job, params.boundaryMs, params.bootstrapMs);
    const next = Math.max(parsed.lastDeliveredRunAtMs ?? Number.NEGATIVE_INFINITY, visible ?? Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(next))
        return null;
    if (parsed.lastDeliveredRunAtMs === null || next > parsed.lastDeliveredRunAtMs) {
        await params.deps.service.update(params.job.id, {
            description: withReceipt(parsed.baseDescription, next),
        });
        assertProjectionActive(params.deps);
    }
    return next;
}
function successfulEntry(runAtMs) {
    return {
        status: "ok",
        completionStatus: "succeeded",
        delivered: true,
        deliveryStatus: "delivered",
        runAtMs,
    };
}
function historyEntries(receiptMs, visibleMs) {
    const values = [receiptMs, visibleMs]
        .filter((value) => value !== null)
        .sort((left, right) => right - left);
    return [...new Set(values)].map(successfulEntry);
}
function engineJob(job, params, peerJobId) {
    return {
        ...job,
        payload: {
            kind: "script",
            script: buildDailyReviewScript({ ...params, peer_job_id: peerJobId }),
            toolsAllow: [TASK_DAILY_REVIEW_TOOL],
        },
        delivery: {
            mode: "announce",
            channel: "telegram",
            to: SYNTHETIC_ACTIVATION_VALIDATED_ROUTE,
            accountId: DAILY_REVIEW_AGENT_ID,
            bestEffort: false,
        },
    };
}
export async function prepareDailyReviewRuntimeProjection(params, toolContext, deps) {
    assertProjectionActive(deps);
    const currentJobId = dailyReviewInternals.parseCurrentCronJobId(toolContext);
    if (!currentJobId) {
        throw new Error(`${TASK_DAILY_REVIEW_TOOL} is available only to the tasks cron script runtime`);
    }
    if (params.peer_job_id === currentJobId) {
        throw new Error("Daily Review peer_job_id must identify the sibling schedule entry");
    }
    const bootstrap = parseInstant(params.bootstrap_checkpoint, "bootstrap_checkpoint");
    const jobs = await deps.service.list({ includeDisabled: true });
    assertProjectionActive(deps);
    const { current, peer } = validatePair(jobs, currentJobId, params.peer_job_id);
    const boundaryMs = current.state?.runningAtMs;
    if (typeof boundaryMs !== "number" || !Number.isFinite(boundaryMs)) {
        throw new Error("Daily Review current native run has no runningAtMs snapshot boundary");
    }
    if (boundaryMs < bootstrap.ms) {
        throw new Error("Daily Review current run predates its activation checkpoint");
    }
    const currentVisible = visibleSuccessfulDelivery(current, boundaryMs, bootstrap.ms);
    const peerVisible = visibleSuccessfulDelivery(peer, boundaryMs, bootstrap.ms);
    const currentReceipt = await promoteReceipt({
        job: current,
        boundaryMs,
        bootstrapMs: bootstrap.ms,
        deps,
    });
    const peerReceipt = await promoteReceipt({
        job: peer,
        boundaryMs,
        bootstrapMs: bootstrap.ms,
        deps,
    });
    const currentHistory = historyEntries(currentReceipt, currentVisible);
    const peerHistory = historyEntries(peerReceipt, peerVisible);
    const projected = new Map([
        [current.id, engineJob(current, params, peer.id)],
        [peer.id, engineJob(peer, params, current.id)],
    ]);
    const histories = new Map([
        [current.id, currentHistory],
        [peer.id, peerHistory],
    ]);
    return async (method, request) => {
        assertProjectionActive(deps);
        const id = typeof request.id === "string" ? request.id : "";
        if (!projected.has(id)) {
            throw new Error(`Daily Review requested scheduler data outside the validated pair: ${id}`);
        }
        if (method === "cron.get")
            return projected.get(id);
        const entries = histories.get(id) ?? [];
        const offset = Number.isSafeInteger(request.offset) && Number(request.offset) >= 0 ? Number(request.offset) : 0;
        const limit = Number.isSafeInteger(request.limit) && Number(request.limit) > 0 ? Math.min(Number(request.limit), 200) : 200;
        const page = entries.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
            entries: page,
            total: entries.length,
            offset,
            limit,
            hasMore: nextOffset < entries.length,
            nextOffset: nextOffset < entries.length ? nextOffset : null,
        };
    };
}
function requireSchedulerGeneration() {
    const serviceBinding = schedulerServiceBinding;
    if (serviceBinding) {
        try {
            const service = serviceBinding.getService();
            if (service) {
                return {
                    service,
                    isCurrent: () => {
                        try {
                            return schedulerServiceBinding === serviceBinding && serviceBinding.getService() === service;
                        }
                        catch {
                            return false;
                        }
                    },
                };
            }
        }
        catch {
            // A revoked service-bound scheduler must fail closed rather than fall back
            // to a potentially stale cron_reconciled snapshot.
        }
        throw new Error("Daily Review scheduler projection is unavailable or stale");
    }
    const generation = schedulerGeneration;
    if (!generation || generation.abortSignal?.aborted) {
        throw new Error("Daily Review scheduler projection is unavailable or stale");
    }
    return {
        ...generation,
        isCurrent: () => schedulerGeneration === generation,
    };
}
export function registerDailyReviewSchedulerAccess(api) {
    api.registerService({
        id: "taskctl-daily-review-scheduler-access",
        start: (context) => {
            const serviceContext = context;
            const getService = serviceContext.getCron;
            schedulerServiceBinding = getService ? { getService } : undefined;
        },
        stop: () => {
            schedulerServiceBinding = undefined;
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
        schedulerGeneration = {
            service: service,
            abortSignal: context.abortSignal,
        };
    });
    api.on("gateway_stop", () => {
        schedulerGeneration = undefined;
    });
}
export function createDailyReviewTool(api, toolContext) {
    if (!dailyReviewInternals.parseCurrentCronJobId(toolContext))
        return null;
    return {
        name: TASK_DAILY_REVIEW_TOOL,
        label: "Task Daily Review",
        description: "Build one fail-closed scheduler-only Daily Review snapshot and semantic duplicate warning set without Task mutations.",
        parameters: dailyReviewParameters,
        execute: async (_toolCallId, rawParams, signal) => {
            const params = rawParams;
            const generation = requireSchedulerGeneration();
            const readGateway = await prepareDailyReviewRuntimeProjection(params, toolContext, generation);
            const result = await executeDailyReview(params, {
                api,
                toolContext,
                signal,
                readGateway,
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                details: result,
            };
        },
    };
}
export const dailyReviewRuntimeInternals = {
    parseReceipt,
    withReceipt,
    visibleSuccessfulDelivery,
    validatePublicJob,
    validatePair,
    promoteReceipt,
    historyEntries,
    requireSchedulerGeneration,
    resetState: () => {
        schedulerGeneration = undefined;
        schedulerServiceBinding = undefined;
    },
};
