import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
const FORMAT = "contacts-important-date-dispatcher-projection-v1";
const LOCK_FORMAT = "contacts-important-date-projection-lock-v1";
const LOCK_RETRIES = 100;
const LOCK_DELAY_MS = 10;
const LOCK_STALE_MS = 30_000;
export function importantDateProjectionPath(stateDir = resolveStateDir()) {
    return join(stateDir, "plugins", "contacts", "important-date-dispatcher.json");
}
function requireObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} is invalid`);
    return value;
}
function requireString(value, label) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${label} is invalid`);
    return value;
}
function parseJob(value) {
    const row = requireObject(value, "Important Dates projected job");
    const schedule = requireObject(row.schedule, "Important Dates projected schedule");
    const payload = requireObject(row.payload, "Important Dates projected payload");
    const delivery = requireObject(row.delivery, "Important Dates projected delivery");
    if (typeof row.enabled !== "boolean")
        throw new Error("Important Dates projected enabled state is invalid");
    if (!Array.isArray(payload.toolsAllow) || !payload.toolsAllow.every((item) => typeof item === "string")) {
        throw new Error("Important Dates projected tool allowlist is invalid");
    }
    if (schedule.staggerMs !== undefined && (typeof schedule.staggerMs !== "number" || !Number.isFinite(schedule.staggerMs))) {
        throw new Error("Important Dates projected stagger is invalid");
    }
    if (delivery.bestEffort !== undefined && typeof delivery.bestEffort !== "boolean") {
        throw new Error("Important Dates projected delivery mode is invalid");
    }
    return {
        id: requireString(row.id, "Important Dates projected job id"),
        declarationKey: requireString(row.declarationKey, "Important Dates projected declaration"),
        agentId: requireString(row.agentId, "Important Dates projected agent"),
        enabled: row.enabled,
        schedule: {
            kind: requireString(schedule.kind, "Important Dates projected schedule kind"),
            expr: requireString(schedule.expr, "Important Dates projected cron"),
            tz: requireString(schedule.tz, "Important Dates projected timezone"),
            ...(schedule.staggerMs === undefined ? {} : { staggerMs: schedule.staggerMs }),
        },
        sessionTarget: requireString(row.sessionTarget, "Important Dates projected session target"),
        payload: {
            kind: requireString(payload.kind, "Important Dates projected payload kind"),
            script: requireString(payload.script, "Important Dates projected script"),
            toolsAllow: [...payload.toolsAllow],
        },
        delivery: {
            mode: requireString(delivery.mode, "Important Dates projected delivery mode"),
            channel: requireString(delivery.channel, "Important Dates projected channel"),
            accountId: requireString(delivery.accountId, "Important Dates projected account"),
            to: requireString(delivery.to, "Important Dates projected recipient"),
            ...(delivery.bestEffort === undefined ? {} : { bestEffort: delivery.bestEffort }),
        },
    };
}
function parseActiveRun(value) {
    if (value === null)
        return null;
    const row = requireObject(value, "Important Dates projected active run");
    if (typeof row.runAtMs !== "number" || !Number.isFinite(row.runAtMs))
        throw new Error("Important Dates projected run boundary is invalid");
    if (typeof row.recordedAtMs !== "number" || !Number.isFinite(row.recordedAtMs))
        throw new Error("Important Dates projected run timestamp is invalid");
    return { runAtMs: row.runAtMs, recordedAtMs: row.recordedAtMs };
}
export function parseImportantDateProjection(text) {
    const row = requireObject(JSON.parse(text), "Important Dates projection");
    if (row.format !== FORMAT || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) {
        throw new Error("Important Dates projection header is invalid");
    }
    const expectedRecipient = requireString(row.expectedRecipient, "Important Dates projected recipient identity");
    if (!/^[1-9]\d*$/.test(expectedRecipient))
        throw new Error("Important Dates projected recipient identity is invalid");
    return {
        format: FORMAT,
        revision: Number(row.revision),
        expectedRecipient,
        job: parseJob(row.job),
        activeRun: parseActiveRun(row.activeRun),
    };
}
export async function readImportantDateProjection(path = importantDateProjectionPath()) {
    return parseImportantDateProjection(await readFile(path, "utf8"));
}
async function atomicWrite(path, value, signal) {
    signal?.throwIfAborted();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        signal?.throwIfAborted();
        await rename(temp, path);
    }
    catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
}
function parseProjectionLock(text) {
    const row = requireObject(JSON.parse(text), "Important Dates projection lock");
    if (row.format !== LOCK_FORMAT || !Number.isSafeInteger(row.pid) || Number(row.pid) < 1) {
        throw new Error("Important Dates projection lock owner is invalid");
    }
    if (typeof row.acquiredAtMs !== "number" || !Number.isFinite(row.acquiredAtMs)) {
        throw new Error("Important Dates projection lock timestamp is invalid");
    }
    return {
        format: LOCK_FORMAT,
        pid: Number(row.pid),
        acquiredAtMs: row.acquiredAtMs,
        token: requireString(row.token, "Important Dates projection lock token"),
    };
}
function lockOwnerAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
async function tryAcquireLock(lock) {
    const token = randomUUID();
    const acquiredAtMs = Date.now();
    const candidate = `${lock}.${process.pid}.${token}.candidate`;
    const value = { format: LOCK_FORMAT, pid: process.pid, acquiredAtMs, token };
    await writeFile(candidate, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
        await link(candidate, lock);
        return token;
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        return null;
    }
    finally {
        await rm(candidate, { force: true });
    }
}
async function recoverStaleLock(lock) {
    const now = Date.now();
    let observed;
    try {
        observed = parseProjectionLock(await readFile(lock, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return true;
        try {
            const metadata = await stat(lock);
            if (now - metadata.mtimeMs < LOCK_STALE_MS)
                return false;
        }
        catch (statError) {
            if (statError.code === "ENOENT")
                return true;
            throw statError;
        }
        await rm(lock, { force: true });
        return true;
    }
    const expired = now - observed.acquiredAtMs >= LOCK_STALE_MS || observed.acquiredAtMs > now + LOCK_STALE_MS;
    if (!expired && lockOwnerAlive(observed.pid))
        return false;
    try {
        const current = parseProjectionLock(await readFile(lock, "utf8"));
        if (current.token !== observed.token)
            return false;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return true;
        return false;
    }
    await rm(lock, { force: true });
    return true;
}
async function releaseLock(lock, token) {
    try {
        const current = parseProjectionLock(await readFile(lock, "utf8"));
        if (current.token === token)
            await rm(lock, { force: true });
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
async function withLock(path, action, signal) {
    const lock = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
        signal?.throwIfAborted();
        const token = await tryAcquireLock(lock);
        if (token) {
            try {
                signal?.throwIfAborted();
                return await action();
            }
            finally {
                await releaseLock(lock, token);
            }
        }
        if (await recoverStaleLock(lock))
            continue;
        await new Promise((resolve) => setTimeout(resolve, LOCK_DELAY_MS));
    }
    throw new Error("Important Dates projection lock is unavailable");
}
function sameStaticProjection(current, expectedRecipient, job) {
    return current.expectedRecipient === expectedRecipient && JSON.stringify(current.job) === JSON.stringify(job);
}
export async function reconcileImportantDateProjection(params) {
    const path = params.path ?? importantDateProjectionPath();
    return withLock(path, async () => {
        let current = null;
        try {
            current = await readImportantDateProjection(path);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const next = {
            format: FORMAT,
            revision: (current?.revision ?? 0) + 1,
            expectedRecipient: params.expectedRecipient,
            job: params.job,
            activeRun: current && sameStaticProjection(current, params.expectedRecipient, params.job) ? current.activeRun : null,
        };
        await atomicWrite(path, next, params.signal);
        return next;
    }, params.signal);
}
export async function removeImportantDateProjection(path = importantDateProjectionPath(), signal) {
    await withLock(path, async () => {
        signal?.throwIfAborted();
        await rm(path, { force: true });
    }, signal);
}
export async function beginImportantDateProjectedRun(params) {
    if (!Number.isFinite(params.runAtMs))
        throw new Error("Important Dates run boundary is invalid");
    const recordedAtMs = params.recordedAtMs ?? Date.now();
    if (!Number.isFinite(recordedAtMs))
        throw new Error("Important Dates run timestamp is invalid");
    const path = params.path ?? importantDateProjectionPath();
    return withLock(path, async () => {
        const current = await readImportantDateProjection(path);
        if (current.job.id !== params.jobId)
            throw new Error("Important Dates run references an unregistered dispatcher");
        const next = {
            ...current,
            revision: current.revision + 1,
            activeRun: { runAtMs: params.runAtMs, recordedAtMs },
        };
        await atomicWrite(path, next);
        return next;
    });
}
export async function finishImportantDateProjectedRun(params) {
    const path = params.path ?? importantDateProjectionPath();
    return withLock(path, async () => {
        const current = await readImportantDateProjection(path);
        if (current.job.id !== params.jobId)
            return current;
        if (current.activeRun?.runAtMs !== params.runAtMs)
            return current;
        const next = { ...current, revision: current.revision + 1, activeRun: null };
        await atomicWrite(path, next);
        return next;
    });
}
