import { Type } from "typebox";
import { runManagementReviewSnapshot } from "./index.js";
export const TASK_MANAGEMENT_REVIEW_TOOL = "task_management_review";
export const MANAGEMENT_REVIEW_DECLARATION = "tasks.management-review.19-00.v1";
const MANAGEMENT_REVIEW_AGENT_ID = "tasks";
export const managementReviewParameters = Type.Object({ boundary: Type.String({ minLength: 20, maxLength: 40 }) }, { additionalProperties: false });
function parseCurrentCronJobId(context) {
    if (context.agentId !== MANAGEMENT_REVIEW_AGENT_ID || !context.sessionKey)
        return null;
    return /^agent:tasks:cron:([^:]+):trigger$/.exec(context.sessionKey)?.[1] ?? null;
}
function canonicalBoundary(value) {
    const date = new Date(value);
    if (!value.trim() || Number.isNaN(date.getTime())) {
        throw new Error("Management Review boundary must be a valid ISO timestamp");
    }
    return date.toISOString();
}
export function buildManagementReviewScript() {
    return [
        `const review = await ${TASK_MANAGEMENT_REVIEW_TOOL}({ boundary: new Date().toISOString() });`,
        'json({ notify: review.message });',
    ].join("\n");
}
export async function executeManagementReview(params, deps = {}) {
    const boundary = canonicalBoundary(params.boundary);
    const result = await (deps.runSnapshot ?? runManagementReviewSnapshot)(boundary, { signal: deps.signal });
    if (!result || Array.isArray(result) || typeof result !== "object") {
        throw new Error("Management Review snapshot result must be an object");
    }
    const record = result;
    if (record.ok !== true) {
        const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
            ? record.error : null;
        throw new Error(`Management Review taskctl snapshot failed: ${typeof error?.message === "string" ? error.message : "unknown error"}`);
    }
    if (record.boundary !== boundary)
        throw new Error("Management Review snapshot boundary mismatch");
    if (typeof record.message !== "string" || !record.message.trim()) {
        throw new Error("Management Review snapshot has no message");
    }
    return record;
}
export function createManagementReviewTool(toolContext) {
    if (!parseCurrentCronJobId(toolContext))
        return null;
    return {
        name: TASK_MANAGEMENT_REVIEW_TOOL,
        label: "Task Management Review",
        description: "Build one fail-closed scheduler-only weekday management report without Task mutations.",
        parameters: managementReviewParameters,
        execute: async (_toolCallId, params, signal) => {
            const result = await executeManagementReview(params, { signal });
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                details: result,
            };
        },
    };
}
export const managementReviewInternals = {
    parseCurrentCronJobId,
    canonicalBoundary,
};
