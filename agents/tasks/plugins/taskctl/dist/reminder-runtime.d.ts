import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
export declare const TASK_REMINDER_DISPATCH_TOOL = "task_reminder_dispatch";
export declare const REMINDER_DISPATCH_DECLARATION = "tasks.reminder-dispatch.v1";
export declare const REMINDER_DISPATCH_NAME = "tasks-reminder-dispatch";
export declare const REMINDER_DISPATCH_CRON = "* * * * *";
export declare const REMINDER_TIMEZONE = "Europe/Moscow";
export declare const reminderDispatchParameters: Type.TObject<{}>;
type SchedulerJob = {
    id: string;
    declarationKey?: string;
    agentId?: string;
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
    };
    state?: {
        runningAtMs?: number;
    };
};
type SchedulerService = {
    list: (opts?: {
        includeDisabled?: boolean;
    }) => Promise<SchedulerJob[]>;
};
type JsonRecord = Record<string, unknown>;
type ActiveClaim = {
    token: string;
    runAtMs: number;
};
declare function parseCurrentCronJobId(sessionKey: string | undefined, agentId?: string): string | null;
declare function claimToken(jobId: string, runAtMs: number): string;
declare function validateReminderJob(job: SchedulerJob): SchedulerJob;
declare function findReminderJob(service: SchedulerService, jobId: string): Promise<SchedulerJob | null>;
export declare function buildReminderDispatchScript(): string;
export declare function executeReminderDispatch(toolContext: OpenClawPluginToolContext, deps?: {
    signal?: AbortSignal;
}): Promise<JsonRecord>;
export declare function createReminderDispatchTool(toolContext: OpenClawPluginToolContext): AnyAgentTool | null;
declare function handleReplyPayloadSending(event: {
    payload: JsonRecord;
    sessionKey?: string;
}, context: {
    channelId: string;
    accountId?: string;
    sessionKey?: string;
}): Promise<{
    cancel: boolean;
    reason: string;
    payload?: undefined;
} | {
    payload: {
        text: string;
    };
    cancel?: undefined;
    reason?: undefined;
} | undefined>;
declare function handleCronChanged(event: {
    action: string;
    jobId: string;
    runAtMs?: number;
    completionStatus?: string;
    delivered?: boolean;
    deliveryStatus?: string;
}): Promise<void>;
export declare function registerReminderRuntime(api: OpenClawPluginApi): void;
export declare const reminderRuntimeInternals: {
    parseCurrentCronJobId: typeof parseCurrentCronJobId;
    claimToken: typeof claimToken;
    validateReminderJob: typeof validateReminderJob;
    findReminderJob: typeof findReminderJob;
    handleReplyPayloadSending: typeof handleReplyPayloadSending;
    handleCronChanged: typeof handleCronChanged;
    resetState: () => void;
    activeClaims: Map<string, ActiveClaim[]>;
    knownReminderJobIds: Set<string>;
};
export {};
