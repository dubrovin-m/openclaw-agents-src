import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { DAILY_REVIEW_DECLARATIONS, DAILY_REVIEW_GROUP_ID } from "./daily-review.js";
const FORMAT = "taskctl-daily-review-checkpoint-v1";
const LOCK_RETRIES = 100;
const LOCK_DELAY_MS = 10;
export function checkpointPath(stateDir = resolveStateDir()) {
    return join(stateDir, "plugins", "taskctl", "daily-review-checkpoint.json");
}
function assertEntry(value, declarationKey) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Daily Review checkpoint entry is invalid");
    const row = value;
    if (typeof row.jobId !== "string" || !row.jobId)
        throw new Error("Daily Review checkpoint job identity is invalid");
    if (row.declarationKey !== declarationKey)
        throw new Error("Daily Review checkpoint declaration identity is invalid");
    if (row.lastDeliveredRunAtMs !== null && (typeof row.lastDeliveredRunAtMs !== "number" || !Number.isFinite(row.lastDeliveredRunAtMs))) {
        throw new Error("Daily Review checkpoint timestamp is invalid");
    }
    return row;
}
export function parseCheckpoint(text) {
    const value = JSON.parse(text);
    if (value.format !== FORMAT || value.groupId !== DAILY_REVIEW_GROUP_ID || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
        throw new Error("Daily Review checkpoint header is invalid");
    }
    if (!value.jobs || typeof value.jobs !== "object" || Array.isArray(value.jobs))
        throw new Error("Daily Review checkpoint jobs are invalid");
    const jobs = value.jobs;
    return {
        format: FORMAT,
        groupId: DAILY_REVIEW_GROUP_ID,
        revision: Number(value.revision),
        jobs: {
            [DAILY_REVIEW_DECLARATIONS.morning]: assertEntry(jobs[DAILY_REVIEW_DECLARATIONS.morning], DAILY_REVIEW_DECLARATIONS.morning),
            [DAILY_REVIEW_DECLARATIONS.evening]: assertEntry(jobs[DAILY_REVIEW_DECLARATIONS.evening], DAILY_REVIEW_DECLARATIONS.evening),
        },
    };
}
export async function readCheckpoint(path = checkpointPath()) {
    return parseCheckpoint(await readFile(path, "utf8"));
}
async function atomicWrite(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
}
async function withLock(path, action) {
    const lock = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
        try {
            const handle = await open(lock, "wx", 0o600);
            await handle.close();
            try {
                return await action();
            }
            finally {
                await rm(lock, { force: true });
            }
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            await new Promise((resolve) => setTimeout(resolve, LOCK_DELAY_MS));
        }
    }
    throw new Error("Daily Review checkpoint lock is unavailable");
}
export async function initializeCheckpoint(params) {
    const path = params.path ?? checkpointPath();
    if (params.entries.length !== 2)
        throw new Error("Daily Review checkpoint requires exactly two jobs");
    return withLock(path, async () => {
        try {
            return await readCheckpoint(path);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const byDeclaration = new Map(params.entries.map((entry) => [entry.declarationKey, entry]));
        const morning = byDeclaration.get(DAILY_REVIEW_DECLARATIONS.morning);
        const evening = byDeclaration.get(DAILY_REVIEW_DECLARATIONS.evening);
        if (!morning || !evening)
            throw new Error("Daily Review checkpoint pair is incomplete");
        const value = {
            format: FORMAT,
            groupId: DAILY_REVIEW_GROUP_ID,
            revision: 1,
            jobs: {
                [DAILY_REVIEW_DECLARATIONS.morning]: morning,
                [DAILY_REVIEW_DECLARATIONS.evening]: evening,
            },
        };
        await atomicWrite(path, value);
        return value;
    });
}
export async function advanceCheckpoint(params) {
    if (!Number.isFinite(params.runAtMs))
        throw new Error("Daily Review delivered timestamp is invalid");
    const path = params.path ?? checkpointPath();
    return withLock(path, async () => {
        const current = await readCheckpoint(path);
        const entry = Object.values(current.jobs).find((candidate) => candidate.jobId === params.jobId);
        if (!entry)
            throw new Error(`Daily Review delivered event references unknown job: ${params.jobId}`);
        if (entry.lastDeliveredRunAtMs !== null && params.runAtMs <= entry.lastDeliveredRunAtMs)
            return current;
        const next = {
            ...current,
            revision: current.revision + 1,
            jobs: {
                ...current.jobs,
                [entry.declarationKey]: { ...entry, lastDeliveredRunAtMs: params.runAtMs },
            },
        };
        await atomicWrite(path, next);
        return next;
    });
}
