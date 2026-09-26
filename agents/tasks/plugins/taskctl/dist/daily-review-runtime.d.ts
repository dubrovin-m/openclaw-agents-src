import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { DAILY_REVIEW_GROUP_ID } from "./daily-review.js";
type DailyReviewParams = {
    group_id: typeof DAILY_REVIEW_GROUP_ID;
    bootstrap_checkpoint: string;
    peer_job_id: string;
};
type SchedulerJob = {
    id: string;
    declarationKey?: string;
    agentId?: string;
    name?: string;
    description?: string;
    enabled?: boolean;
    schedule?: {
        kind?: string;
        expr?: string;
        tz?: string;
        staggerMs?: number;
    };
    sessionTarget?: string;
    wakeMode?: string;
    payload?: {
        kind?: string;
        text?: string;
    };
    state?: {
        runningAtMs?: number;
        lastRunAtMs?: number;
        lastRunStatus?: "ok" | "error" | "skipped";
        lastDelivered?: boolean;
        lastDeliveryStatus?: "not-requested" | "delivered" | "not-delivered" | "unknown";
    };
};
type SchedulerService = {
    list: (opts?: {
        includeDisabled?: boolean;
    }) => Promise<SchedulerJob[]>;
    update: (id: string, patch: {
        description?: string;
    }) => Promise<unknown>;
};
type SchedulerGeneration = {
    service: SchedulerService;
    abortSignal?: AbortSignal;
};
type ProjectionDeps = SchedulerGeneration & {
    isCurrent?: () => boolean;
};
type Receipt = {
    baseDescription: string;
    lastDeliveredRunAtMs: number | null;
};
declare function parseReceipt(description: string | undefined): Receipt;
declare function withReceipt(baseDescription: string, runAtMs: number): string;
declare function visibleSuccessfulDelivery(job: SchedulerJob, boundaryMs: number, bootstrapMs: number): number | null;
declare function validatePublicJob(job: SchedulerJob, label: string): {
    declaration: "tasks.daily-review.09-30.v1";
    peer: "tasks.daily-review.17-00.v1";
    expr: string;
} | {
    declaration: "tasks.daily-review.17-00.v1";
    peer: "tasks.daily-review.09-30.v1";
    expr: string;
};
declare function validatePair(jobs: SchedulerJob[], currentJobId: string, peerJobId: string): {
    current: SchedulerJob;
    peer: SchedulerJob;
};
declare function promoteReceipt(params: {
    job: SchedulerJob;
    boundaryMs: number;
    bootstrapMs: number;
    deps: ProjectionDeps;
}): Promise<number | null>;
declare function historyEntries(receiptMs: number | null, visibleMs: number | null): {
    status: string;
    completionStatus: string;
    delivered: boolean;
    deliveryStatus: string;
    runAtMs: number;
}[];
export declare function prepareDailyReviewRuntimeProjection(params: DailyReviewParams, toolContext: OpenClawPluginToolContext, deps: ProjectionDeps): Promise<(method: "cron.get" | "cron.runs", request: Record<string, unknown>) => Promise<{
    payload: {
        kind: string;
        script: string;
        toolsAllow: string[];
    };
    delivery: {
        mode: string;
        channel: string;
        to: string;
        accountId: string;
        bestEffort: boolean;
    };
    id: string;
    declarationKey?: string;
    agentId?: string;
    name?: string;
    description?: string;
    enabled?: boolean;
    schedule?: {
        kind?: string;
        expr?: string;
        tz?: string;
        staggerMs?: number;
    };
    sessionTarget?: string;
    wakeMode?: string;
    state?: {
        runningAtMs?: number;
        lastRunAtMs?: number;
        lastRunStatus?: "ok" | "error" | "skipped";
        lastDelivered?: boolean;
        lastDeliveryStatus?: "not-requested" | "delivered" | "not-delivered" | "unknown";
    };
} | {
    entries: {
        status: string;
        completionStatus: string;
        delivered: boolean;
        deliveryStatus: string;
        runAtMs: number;
    }[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
} | undefined>>;
declare function requireSchedulerGeneration(): ProjectionDeps;
export declare function registerDailyReviewSchedulerAccess(api: OpenClawPluginApi): void;
export declare function createDailyReviewTool(api: OpenClawPluginApi, toolContext: OpenClawPluginToolContext): AnyAgentTool | null;
export declare const dailyReviewRuntimeInternals: {
    parseReceipt: typeof parseReceipt;
    withReceipt: typeof withReceipt;
    visibleSuccessfulDelivery: typeof visibleSuccessfulDelivery;
    validatePublicJob: typeof validatePublicJob;
    validatePair: typeof validatePair;
    promoteReceipt: typeof promoteReceipt;
    historyEntries: typeof historyEntries;
    requireSchedulerGeneration: typeof requireSchedulerGeneration;
    resetState: () => void;
};
export {};
