import { type ChildProcessWithoutNullStreams } from "node:child_process";
export declare const CONTACTCTL_EXECUTABLE = "/home/dubrovin/.local/bin/contactctl";
export declare const CONTACTCTL_TIMEOUT_MS = 10000;
export declare const CONTACTCTL_OUTPUT_LIMIT_BYTES: number;
export declare const ACTIONS: {
    readonly contact_search: "search";
    readonly contact_resolve: "resolve";
    readonly contact_get: "get";
    readonly contact_create: "create";
    readonly contact_update: "update";
    readonly contact_rename: "rename";
    readonly contact_alias_add: "alias_add";
    readonly contact_alias_remove: "alias_remove";
    readonly contact_merge: "merge";
};
export type ContactAction = keyof typeof ACTIONS;
type JsonObject = Record<string, unknown>;
type SpawnContactctl = (executable: string, argv: readonly string[], options: {
    shell: false;
    env: NodeJS.ProcessEnv;
    stdio: readonly ["ignore", "pipe", "pipe"];
}) => ChildProcessWithoutNullStreams;
export declare function executeContactctl(action: ContactAction, payload: JsonObject, options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    spawnImpl?: SpawnContactctl;
}): Promise<unknown>;
export {};
