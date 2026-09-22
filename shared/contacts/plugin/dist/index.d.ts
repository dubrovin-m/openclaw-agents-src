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
    readonly contact_group_list: "group_list";
    readonly contact_group_get: "group_get";
    readonly contact_group_create: "group_create";
    readonly contact_group_rename: "group_rename";
    readonly contact_group_member_add: "group_member_add";
    readonly contact_group_member_remove: "group_member_remove";
    readonly contact_date_create: "date_create";
    readonly contact_date_list: "date_list";
    readonly contact_date_update: "date_update";
    readonly contact_date_reminders_set: "date_reminders_set";
    readonly contact_date_delete: "date_delete";
    readonly contact_date_upcoming: "date_upcoming";
};
export type ContactAction = keyof typeof ACTIONS;
export type ImportantDateInternalAction = "date_dispatch" | "date_render" | "date_settle";
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
export declare function runImportantDateInternal(action: ImportantDateInternalAction, payload: JsonObject, options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    spawnImpl?: SpawnContactctl;
}): Promise<unknown>;
export {};
