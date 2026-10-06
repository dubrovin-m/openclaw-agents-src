import "node-fetch";
import { type RuleProposalStore } from "./rules.js";
export declare const CALENDAR_AGENT_ID = "calendar";
type ToolEvent = {
    toolName?: string;
    params?: Record<string, unknown>;
};
type ToolContext = {
    agentId?: string;
};
export declare function calendarToolPolicy(configValue: unknown, event: ToolEvent, context: ToolContext, proposalStore?: RuleProposalStore): Promise<{
    block: boolean;
    blockReason: string;
} | {
    requireApproval: {
        title: string;
        description: string;
        severity: "warning";
        timeoutMs: number;
        timeoutReason: string;
        allowedDecisions: Array<"allow-once" | "deny">;
    };
} | undefined>;
export {};
