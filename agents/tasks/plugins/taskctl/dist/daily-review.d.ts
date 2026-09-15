import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";
export declare const TASK_DAILY_REVIEW_TOOL = "task_daily_review";
export declare const DAILY_REVIEW_GROUP_ID = "tasks-daily-review-v1";
export declare const DAILY_REVIEW_DECLARATIONS: {
    readonly morning: "tasks.daily-review.09-30.v1";
    readonly evening: "tasks.daily-review.17-00.v1";
};
export declare const dailyReviewParameters: Type.TObject<{
    group_id: Type.TLiteral<"tasks-daily-review-v1">;
    bootstrap_checkpoint: Type.TString;
    peer_job_id: Type.TString;
}>;
type DailyReviewParams = Static<typeof dailyReviewParameters>;
type DailyReviewDependencies = {
    api: OpenClawPluginApi;
    toolContext: OpenClawPluginToolContext;
    signal?: AbortSignal;
    readGateway?: (method: "cron.get" | "cron.runs", params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
    loadSnapshot?: (boundaryIso: string) => ReviewSnapshot | Promise<ReviewSnapshot>;
    runSemanticModel?: (prompt: string, jobId: string, signal?: AbortSignal) => Promise<string>;
};
type ReviewTask = {
    id: string;
    numericId: number;
    title: string;
    assignee: string;
    dueDate: string | null;
    dueTime: string | null;
    projectId: string | null;
    projectTitle: string | null;
    projectStatus: string | null;
    createdAt: string;
    labels: Array<{
        id: string;
        displayName: string;
        emoji: string | null;
    }>;
};
type ReviewSnapshot = {
    inboxCount: number;
    tasks: ReviewTask[];
};
type CronJobView = {
    id: string;
    declarationKey?: string;
    agentId?: string;
    sessionTarget?: string;
    schedule?: {
        kind?: string;
        expr?: string;
        tz?: string;
    };
    payload?: {
        kind?: string;
        script?: string;
        toolsAllow?: string[];
    };
    delivery?: {
        mode?: string;
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string | number;
        bestEffort?: boolean;
    };
    state?: {
        runningAtMs?: number;
    };
};
type CronRunEntry = {
    status?: string;
    completionStatus?: string;
    delivered?: boolean;
    deliveryStatus?: string;
    runAtMs?: number;
};
type DuplicatePair = {
    firstId: string;
    secondId: string;
};
type DailyReviewResult = {
    ok: true;
    suppress: boolean;
    message?: string;
    snapshot_boundary: string;
    previous_successful_checkpoint: string;
    candidate_count: number;
    duplicate_pair_count: number;
    semantic_calls: number;
};
declare function parseCurrentCronJobId(context: OpenClawPluginToolContext): string | null;
export declare function buildDailyReviewScript(params: DailyReviewParams): string;
declare function isSuccessfulDeliveredRun(entry: CronRunEntry): entry is CronRunEntry & {
    runAtMs: number;
};
declare function resolveCheckpoint(params: {
    currentHistory: CronRunEntry[];
    peerHistory: CronRunEntry[];
    currentBoundaryMs: number;
    bootstrapMs: number;
}): number;
declare function sameOccurrenceAlreadyDelivered(history: CronRunEntry[], boundaryMs: number): boolean;
declare function assertNoEarlierPeerRun(params: {
    current: CronJobView;
    peer: CronJobView;
    boundaryMs: number;
}): void;
declare function loadReviewSnapshot(boundaryIso: string, signal?: AbortSignal): Promise<ReviewSnapshot>;
declare function boundedChunks<T>(items: T[], maxBytes: number): T[][];
declare function parseSemanticPairs(text: string, candidateIds: Set<string>, populationIds: Set<string>): DuplicatePair[];
declare function assertSemanticCallCapacity(estimatedCalls: number): void;
declare function primaryBucket(task: ReviewTask, localDate: string, _localTime: string): 0 | 1 | 2;
declare function reviewInboxCount(declarationKey: string | undefined, inboxCount: number): number | undefined;
declare function renderReview(tasks: ReviewTask[], pairs: DuplicatePair[], boundaryMs: number, inboxCount?: number): string;
export declare function executeDailyReview(params: DailyReviewParams, deps: DailyReviewDependencies): Promise<DailyReviewResult>;
export declare function createDailyReviewTool(api: OpenClawPluginApi, toolContext: OpenClawPluginToolContext): AnyAgentTool | null;
export declare const dailyReviewInternals: {
    parseCurrentCronJobId: typeof parseCurrentCronJobId;
    isSuccessfulDeliveredRun: typeof isSuccessfulDeliveredRun;
    resolveCheckpoint: typeof resolveCheckpoint;
    sameOccurrenceAlreadyDelivered: typeof sameOccurrenceAlreadyDelivered;
    assertNoEarlierPeerRun: typeof assertNoEarlierPeerRun;
    boundedChunks: typeof boundedChunks;
    assertSemanticCallCapacity: typeof assertSemanticCallCapacity;
    parseSemanticPairs: typeof parseSemanticPairs;
    primaryBucket: typeof primaryBucket;
    reviewInboxCount: typeof reviewInboxCount;
    renderReview: typeof renderReview;
    loadReviewSnapshot: typeof loadReviewSnapshot;
};
export {};
