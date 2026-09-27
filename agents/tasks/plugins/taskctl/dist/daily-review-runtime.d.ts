import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { DAILY_REVIEW_GROUP_ID } from "./daily-review.js";
import { type DailyReviewCheckpointEntry } from "./daily-review-checkpoint.js";
type DailyReviewParams = {
    group_id: typeof DAILY_REVIEW_GROUP_ID;
    bootstrap_checkpoint: string;
    peer_job_id: string;
};
type SchedulerJob = {
    id: string;
    declarationKey?: string;
    agentId?: string;
    description?: string;
    enabled?: boolean;
    schedule?: {
        kind?: string;
        expr?: string;
        tz?: string;
        staggerMs?: number;
    };
    sessionTarget?: string;
    payload?: {
        kind?: string;
        text?: string;
    };
    state?: {
        lastRunAtMs?: number;
        lastRunStatus?: "ok" | "error" | "skipped";
        lastDelivered?: boolean;
        lastDeliveryStatus?: "not-requested" | "delivered" | "not-delivered" | "unknown";
    };
};
type Receipt = {
    baseDescription: string;
    lastDeliveredRunAtMs: number | null;
};
declare function parseReceipt(description: string | undefined): Receipt;
declare function validatePublicJob(job: SchedulerJob, label: string): {
    readonly declaration: "tasks.daily-review.09-30.v1";
    readonly peer: "tasks.daily-review.17-00.v1";
    readonly expr: "30 9 * * *";
} | {
    readonly declaration: "tasks.daily-review.17-00.v1";
    readonly peer: "tasks.daily-review.09-30.v1";
    readonly expr: "0 17 * * *";
};
declare function validatePair(jobs: SchedulerJob[]): {
    morning: SchedulerJob;
    evening: SchedulerJob;
};
declare function visibleSuccessfulDelivery(job: SchedulerJob): number | null;
declare function migrationEntry(job: SchedulerJob): DailyReviewCheckpointEntry;
export declare function prepareDailyReviewRuntimeProjection(params: DailyReviewParams, toolContext: OpenClawPluginToolContext, options?: {
    path?: string;
    boundaryMs?: number;
}): Promise<(method: "cron.get" | "cron.runs", request: Record<string, unknown>) => Promise<{
    id: string;
    declarationKey: "tasks.daily-review.09-30.v1" | "tasks.daily-review.17-00.v1";
    agentId: string;
    enabled: boolean;
    schedule: {
        kind: string;
        expr: "30 9 * * *" | "0 17 * * *";
        tz: string;
        staggerMs: number;
    };
    sessionTarget: string;
    wakeMode: string;
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
    state: {
        runningAtMs?: undefined;
    } | {
        runningAtMs: number;
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
export declare function registerDailyReviewSchedulerAccess(api: OpenClawPluginApi): void;
export declare function createDailyReviewTool(api: OpenClawPluginApi, toolContext: OpenClawPluginToolContext): AnyAgentTool | null;
export declare const dailyReviewRuntimeInternals: {
    parseReceipt: typeof parseReceipt;
    visibleSuccessfulDelivery: typeof visibleSuccessfulDelivery;
    validatePublicJob: typeof validatePublicJob;
    validatePair: typeof validatePair;
    migrationEntry: typeof migrationEntry;
};
export {};
