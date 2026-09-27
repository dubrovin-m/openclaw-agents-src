import { DAILY_REVIEW_DECLARATIONS, DAILY_REVIEW_GROUP_ID } from "./daily-review.js";
declare const FORMAT = "taskctl-daily-review-checkpoint-v1";
type Declaration = typeof DAILY_REVIEW_DECLARATIONS.morning | typeof DAILY_REVIEW_DECLARATIONS.evening;
export type DailyReviewCheckpointEntry = {
    jobId: string;
    declarationKey: Declaration;
    lastDeliveredRunAtMs: number | null;
};
export type DailyReviewCheckpoint = {
    format: typeof FORMAT;
    groupId: typeof DAILY_REVIEW_GROUP_ID;
    revision: number;
    jobs: Record<Declaration, DailyReviewCheckpointEntry>;
};
export declare function checkpointPath(stateDir?: string): string;
export declare function parseCheckpoint(text: string): DailyReviewCheckpoint;
export declare function readCheckpoint(path?: string): Promise<DailyReviewCheckpoint>;
export declare function initializeCheckpoint(params: {
    path?: string;
    entries: Array<DailyReviewCheckpointEntry>;
}): Promise<DailyReviewCheckpoint>;
export declare function advanceCheckpoint(params: {
    path?: string;
    jobId: string;
    runAtMs: number;
}): Promise<DailyReviewCheckpoint>;
export {};
