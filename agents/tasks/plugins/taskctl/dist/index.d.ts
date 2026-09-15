import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { type TaskctlAction } from "./contract.js";
export { ACTION_REGISTRY, TASKCTL_ACTIONS, type TaskctlAction } from "./contract.js";
export declare const TASKCTL_EXECUTABLE = "/home/dubrovin/.local/bin/taskctl";
export declare const TASKCTL_TIMEOUT_MS = 10000;
export declare const TASKCTL_OUTPUT_LIMIT_BYTES: number;
type JsonObject = Record<string, unknown>;
declare function validationError(message: string, details?: JsonObject): {
    ok: boolean;
    error: {
        code: string;
        message: string;
    };
};
export declare function validateAndSanitizePayload(action: unknown, payload: unknown): {
    ok: true;
    action: TaskctlAction;
    payload: JsonObject;
} | {
    ok: false;
    error: ReturnType<typeof validationError>;
};
export type TaskctlInvocation = {
    executable: typeof TASKCTL_EXECUTABLE;
    argv: readonly string[];
    options: {
        shell: false;
        env: NodeJS.ProcessEnv;
        stdio: readonly ["ignore", "pipe", "pipe"];
    };
};
export declare function buildInvocation(action: TaskctlAction, payload: JsonObject): TaskctlInvocation;
export type SpawnTaskctl = (executable: string, argv: readonly string[], options: TaskctlInvocation["options"]) => ChildProcessWithoutNullStreams;
export type RunOptions = {
    timeoutMs?: number;
    outputLimitBytes?: number;
    signal?: AbortSignal;
    spawnImpl?: SpawnTaskctl;
};
export declare function executeTaskctl(action: unknown, payload: unknown, options?: RunOptions): Promise<unknown>;
export declare function runTaskctl(action: TaskctlAction, payload: JsonObject, options?: RunOptions): Promise<unknown>;
export declare function buildDailyReviewSnapshotInvocation(boundaryIso: string): TaskctlInvocation;
export declare function runDailyReviewSnapshot(boundaryIso: string, options?: RunOptions): Promise<unknown>;
