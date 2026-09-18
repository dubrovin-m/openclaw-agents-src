import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
export declare const CONTACT_DATE_REMINDER_DISPATCH_TOOL = "contact_date_reminder_dispatch";
export declare const IMPORTANT_DATE_DISPATCH_DECLARATION = "contacts.important-dates.dispatch.v1";
export declare const IMPORTANT_DATE_DISPATCH_NAME = "contacts-important-dates-dispatch";
export declare const IMPORTANT_DATE_DISPATCH_CRON = "0 9 * * *";
export declare const IMPORTANT_DATE_TIMEZONE = "Europe/Moscow";
export declare const importantDateDispatchParameters: Type.TObject<{}>;
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
        script?: string;
        toolsAllow?: string[];
    };
    delivery?: {
        mode?: string;
        channel?: string;
        accountId?: string;
        to?: string;
        bestEffort?: boolean;
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
declare function parseCurrentJobId(sessionKey: string | undefined, agentId?: string): string | null;
declare function claimToken(jobId: string, runAtMs: number): string;
declare function resolveExpectedRecipient(config: unknown): string;
declare function validateJob(job: SchedulerJob, expectedRecipient: string): SchedulerJob;
declare function findJob(service: SchedulerService, jobId: string, expectedRecipient: string): Promise<SchedulerJob | null>;
export declare function buildImportantDateDispatchScript(): string;
export declare function executeImportantDateDispatch(toolContext: OpenClawPluginToolContext, deps?: {
    signal?: AbortSignal;
}): Promise<JsonRecord>;
export declare function createImportantDateDispatchTool(toolContext: OpenClawPluginToolContext): AnyAgentTool | null;
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
export declare function registerImportantDateRuntime(api: OpenClawPluginApi): void;
export declare const importantDateRuntimeInternals: {
    parseCurrentJobId: typeof parseCurrentJobId;
    claimToken: typeof claimToken;
    resolveExpectedRecipient: typeof resolveExpectedRecipient;
    validateJob: typeof validateJob;
    findJob: typeof findJob;
    handleReplyPayloadSending: typeof handleReplyPayloadSending;
    handleCronChanged: typeof handleCronChanged;
    resetState: () => void;
    activeClaims: Map<string, ActiveClaim[]>;
    knownJobIds: Set<string>;
};
export {};
