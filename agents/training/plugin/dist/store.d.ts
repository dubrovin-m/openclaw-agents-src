import { DatabaseSync } from "node:sqlite";
export declare const TRAINING_SCHEMA_VERSION = 2;
export declare function nowIso(): string;
export declare function newId(prefix: string): string;
export declare function openTrainingStore(databasePath: string): DatabaseSync;
export declare function withTransaction<T>(db: DatabaseSync, effect: () => T): T;
export declare function withToolCallReceipt<T>(db: DatabaseSync, params: {
    toolCallId: string;
    operationName: string;
    inputHash: string;
}, effect: () => T): {
    replayed: boolean;
    result: T;
};
export declare function healthSnapshot(db: DatabaseSync): {
    schema_version: number;
    integrity: string;
    foreign_key_violations: number;
    counts: {
        programs: number;
        sessions: number;
        exercises: number;
    };
};
