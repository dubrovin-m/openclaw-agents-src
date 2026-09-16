import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";
import { runManagementReviewSnapshot } from "./index.js";
export declare const TASK_MANAGEMENT_REVIEW_TOOL = "task_management_review";
export declare const MANAGEMENT_REVIEW_DECLARATION = "tasks.management-review.19-00.v1";
export declare const managementReviewParameters: Type.TObject<{
    boundary: Type.TString;
}>;
type ManagementReviewParams = Static<typeof managementReviewParameters>;
declare function parseCurrentCronJobId(context: OpenClawPluginToolContext): string | null;
declare function canonicalBoundary(value: string): string;
export declare function buildManagementReviewScript(): string;
export declare function executeManagementReview(params: ManagementReviewParams, deps?: {
    signal?: AbortSignal;
    runSnapshot?: typeof runManagementReviewSnapshot;
}): Promise<Record<string, unknown>>;
export declare function createManagementReviewTool(toolContext: OpenClawPluginToolContext): AnyAgentTool | null;
export declare const managementReviewInternals: {
    parseCurrentCronJobId: typeof parseCurrentCronJobId;
    canonicalBoundary: typeof canonicalBoundary;
};
export {};
