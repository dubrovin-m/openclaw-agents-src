declare const FORMAT = "contacts-important-date-dispatcher-projection-v1";
export type ImportantDateProjectedJob = {
    id: string;
    declarationKey: string;
    agentId: string;
    enabled: boolean;
    schedule: {
        kind: string;
        expr: string;
        tz: string;
        staggerMs?: number;
    };
    sessionTarget: string;
    payload: {
        kind: string;
        script: string;
        toolsAllow: string[];
    };
    delivery: {
        mode: string;
        channel: string;
        accountId: string;
        to: string;
        bestEffort?: boolean;
    };
};
export type ImportantDateActiveRun = {
    runAtMs: number;
    recordedAtMs: number;
};
export type ImportantDateProjection = {
    format: typeof FORMAT;
    revision: number;
    expectedRecipient: string;
    job: ImportantDateProjectedJob;
    activeRun: ImportantDateActiveRun | null;
};
export declare function importantDateProjectionPath(stateDir?: string): string;
export declare function parseImportantDateProjection(text: string): ImportantDateProjection;
export declare function readImportantDateProjection(path?: string): Promise<ImportantDateProjection>;
export declare function reconcileImportantDateProjection(params: {
    path?: string;
    expectedRecipient: string;
    job: ImportantDateProjectedJob;
    signal?: AbortSignal;
}): Promise<ImportantDateProjection>;
export declare function removeImportantDateProjection(path?: string, signal?: AbortSignal): Promise<void>;
export declare function beginImportantDateProjectedRun(params: {
    path?: string;
    jobId: string;
    runAtMs: number;
    recordedAtMs?: number;
}): Promise<ImportantDateProjection>;
export declare function finishImportantDateProjectedRun(params: {
    path?: string;
    jobId: string;
    runAtMs: number;
}): Promise<ImportantDateProjection>;
export {};
