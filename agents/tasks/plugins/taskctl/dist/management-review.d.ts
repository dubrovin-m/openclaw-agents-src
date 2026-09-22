import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";
import { runManagementReviewSnapshot } from "./index.js";
export declare const TASK_MANAGEMENT_REVIEW_TOOL = "task_management_review";
export declare const MANAGEMENT_REVIEW_DECLARATION = "tasks.management-review.19-00.v1";
export declare const managementReviewParameters: Type.TObject<{
    boundary: Type.TString;
}>;
type ManagementReviewParams = Static<typeof managementReviewParameters>;
type ReviewComment = {
    id: string;
    content: string;
    createdAt: string;
};
type PendingRequest = {
    requestedDueDate: string | null;
    requestedDueTime: string | null;
    reason: string;
};
type ReviewTask = {
    id: string;
    title: string;
    assignee: string;
    dueDate: string;
    dueTime: string | null;
    comments: ReviewComment[];
    pending: PendingRequest | null;
};
type CompletedTask = {
    id: string;
    title: string;
    assignee: string;
    completedAt: string;
};
type Snapshot = {
    boundary: string;
    localDate: string;
    completed: CompletedTask[];
    notCompleted: ReviewTask[];
};
type Dependencies = {
    api?: OpenClawPluginApi;
    toolContext?: OpenClawPluginToolContext;
    signal?: AbortSignal;
    runSnapshot?: typeof runManagementReviewSnapshot;
    runSemanticModel?: (prompt: string, jobId: string, signal?: AbortSignal) => Promise<string>;
};
declare function parseCurrentCronJobId(context: OpenClawPluginToolContext): string | null;
declare function canonicalBoundary(value: string): string;
declare function parseSnapshot(raw: unknown, boundary: string): Snapshot;
declare function semanticCandidates(tasks: ReviewTask[]): ReviewTask[];
declare function parseSelections(raw: string, tasks: ReviewTask[]): Map<string, string>;
declare function render(snapshot: Snapshot, selections: Map<string, string>): string;
export declare function buildManagementReviewScript(): string;
export declare function executeManagementReview(params: ManagementReviewParams, deps?: Dependencies): Promise<{
    ok: boolean;
    boundary: string;
    local_date: string;
    completed_count: number;
    not_completed_count: number;
    semantic_calls: number;
    message: string;
}>;
export declare function createManagementReviewTool(api: OpenClawPluginApi, toolContext: OpenClawPluginToolContext): AnyAgentTool | null;
export declare const managementReviewInternals: {
    parseCurrentCronJobId: typeof parseCurrentCronJobId;
    canonicalBoundary: typeof canonicalBoundary;
    parseSnapshot: typeof parseSnapshot;
    parseSelections: typeof parseSelections;
    render: typeof render;
    semanticCandidates: typeof semanticCandidates;
};
export {};
