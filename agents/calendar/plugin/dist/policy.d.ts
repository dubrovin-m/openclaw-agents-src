export declare const CALENDAR_AGENT_ID = "calendar";
type ToolEvent = {
    toolName?: string;
    params?: Record<string, unknown>;
};
type ToolContext = {
    agentId?: string;
};
export declare function calendarToolPolicy(configValue: unknown, event: ToolEvent, context: ToolContext): {
    block: boolean;
    blockReason: string;
} | undefined;
export {};