import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const FORMAT = "contacts-important-date-dispatcher-projection-v1";
const LOCK_FORMAT = "contacts-important-date-projection-lock-v1";
const LOCK_RETRIES = 100;
const LOCK_DELAY_MS = 10;
const LOCK_STALE_MS = 30_000;

export type ImportantDateProjectedJob = {
  id: string;
  declarationKey: string;
  agentId: string;
  enabled: boolean;
  schedule: { kind: string; expr: string; tz: string; staggerMs?: number };
  sessionTarget: string;
  payload: { kind: string; script: string; toolsAllow: string[] };
  delivery: { mode: string; channel: string; accountId: string; to: string; bestEffort?: boolean };
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

export function importantDateProjectionPath(stateDir = resolveStateDir()): string {
  return join(stateDir, "plugins", "contacts", "important-date-dispatcher.json");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid`);
  return value;
}

function parseJob(value: unknown): ImportantDateProjectedJob {
  const row = requireObject(value, "Important Dates projected job");
  const schedule = requireObject(row.schedule, "Important Dates projected schedule");
  const payload = requireObject(row.payload, "Important Dates projected payload");
  const delivery = requireObject(row.delivery, "Important Dates projected delivery");
  if (typeof row.enabled !== "boolean") throw new Error("Important Dates projected enabled state is invalid");
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
      ...(schedule.staggerMs === undefined ? {} : { staggerMs: schedule.staggerMs as number }),
    },
    sessionTarget: requireString(row.sessionTarget, "Important Dates projected session target"),
    payload: {
      kind: requireString(payload.kind, "Important Dates projected payload kind"),
      script: requireString(payload.script, "Important Dates projected script"),
      toolsAllow: [...payload.toolsAllow] as string[],
    },
    delivery: {
      mode: requireString(delivery.mode, "Important Dates projected delivery mode"),
      channel: requireString(delivery.channel, "Important Dates projected channel"),
      accountId: requireString(delivery.accountId, "Important Dates projected account"),
      to: requireString(delivery.to, "Important Dates projected recipient"),
      ...(delivery.bestEffort === undefined ? {} : { bestEffort: delivery.bestEffort as boolean }),
    },
  };
}

function parseActiveRun(value: unknown): ImportantDateActiveRun | null {
  if (value === null) return null;
  const row = requireObject(value, "Important Dates projected active run");
  if (typeof row.runAtMs !== "number" || !Number.isFinite(row.runAtMs)) throw new Error("Important Dates projected run boundary is invalid");
  if (typeof row.recordedAtMs !== "number" || !Number.isFinite(row.recordedAtMs)) throw new Error("Important Dates projected run timestamp is invalid");
  return { runAtMs: row.runAtMs, recordedAtMs: row.recordedAtMs };
}

export function parseImportantDateProjection(text: string): ImportantDateProjection {
  const row = requireObject(JSON.parse(text), "Important Dates projection");
  if (row.format !== FORMAT || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) {
    throw new Error("Important Dates projection header is invalid");
  }
  const expectedRecipient = requireString(row.expectedRecipient, "Important Dates projected recipient identity");
  if (!/^[1-9]\d*$/.test(expectedRecipient)) throw new Error("Important Dates projected recipient identity is invalid");
  return {
    format: FORMAT,
    revision: Number(row.revision),
    expectedRecipient,
    job: parseJob(row.job),
    activeRun: parseActiveRun(row.activeRun),
  };
}

export async function readImportantDateProjection(path = importantDateProjectionPath()): Promise<ImportantDateProjection> {
  return parseImportantDateProjection(await readFile(path, "utf8"));
}

async function atomicWrite(path: string, value: ImportantDateProjection, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    signal?.throwIfAborted();
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

type ImportantDateProjectionLock = {
  format: typeof LOCK_FORMAT;
  pid: number;
  acquiredAtMs: number;
  token: string;
};

function parseProjectionLock(text: string): ImportantDateProjectionLock {
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

function lockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function tryAcquireLock(lock: string): Promise<string | null> {
  const token = randomUUID();
  const acquiredAtMs = Date.now();
  const candidate = `${lock}.${process.pid}.${token}.candidate`;
  const value: ImportantDateProjectionLock = { format: LOCK_FORMAT, pid: process.pid, acquiredAtMs, token };
  await writeFile(candidate, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await link(candidate, lock);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return null;
  } finally {
    await rm(candidate, { force: true });
  }
}

async function recoverStaleLock(lock: string): Promise<boolean> {
  const now = Date.now();
  let observed: ImportantDateProjectionLock;
  try {
    observed = parseProjectionLock(await readFile(lock, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    try {
      const metadata = await stat(lock);
      if (now - metadata.mtimeMs < LOCK_STALE_MS) return false;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw statError;
    }
    await rm(lock, { force: true });
    return true;
  }
  const expired = now - observed.acquiredAtMs >= LOCK_STALE_MS || observed.acquiredAtMs > now + LOCK_STALE_MS;
  if (!expired && lockOwnerAlive(observed.pid)) return false;
  try {
    const current = parseProjectionLock(await readFile(lock, "utf8"));
    if (current.token !== observed.token) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  await rm(lock, { force: true });
  return true;
}

async function releaseLock(lock: string, token: string): Promise<void> {
  try {
    const current = parseProjectionLock(await readFile(lock, "utf8"));
    if (current.token === token) await rm(lock, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function withLock<T>(path: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    signal?.throwIfAborted();
    const token = await tryAcquireLock(lock);
    if (token) {
      try {
        signal?.throwIfAborted();
        return await action();
      } finally {
        await releaseLock(lock, token);
      }
    }
    if (await recoverStaleLock(lock)) continue;
    await new Promise((resolve) => setTimeout(resolve, LOCK_DELAY_MS));
  }
  throw new Error("Important Dates projection lock is unavailable");
}

function sameStaticProjection(current: ImportantDateProjection, expectedRecipient: string, job: ImportantDateProjectedJob): boolean {
  return current.expectedRecipient === expectedRecipient && JSON.stringify(current.job) === JSON.stringify(job);
}

export async function reconcileImportantDateProjection(params: {
  path?: string;
  expectedRecipient: string;
  job: ImportantDateProjectedJob;
  signal?: AbortSignal;
}): Promise<ImportantDateProjection> {
  const path = params.path ?? importantDateProjectionPath();
  return withLock(path, async () => {
    let current: ImportantDateProjection | null = null;
    try { current = await readImportantDateProjection(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next: ImportantDateProjection = {
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

export async function removeImportantDateProjection(path = importantDateProjectionPath(), signal?: AbortSignal): Promise<void> {
  await withLock(path, async () => {
    signal?.throwIfAborted();
    await rm(path, { force: true });
  }, signal);
}

export async function beginImportantDateProjectedRun(params: {
  path?: string;
  jobId: string;
  runAtMs: number;
  recordedAtMs?: number;
}): Promise<ImportantDateProjection> {
  if (!Number.isFinite(params.runAtMs)) throw new Error("Important Dates run boundary is invalid");
  const recordedAtMs = params.recordedAtMs ?? Date.now();
  if (!Number.isFinite(recordedAtMs)) throw new Error("Important Dates run timestamp is invalid");
  const path = params.path ?? importantDateProjectionPath();
  return withLock(path, async () => {
    const current = await readImportantDateProjection(path);
    if (current.job.id !== params.jobId) throw new Error("Important Dates run references an unregistered dispatcher");
    const next: ImportantDateProjection = {
      ...current,
      revision: current.revision + 1,
      activeRun: { runAtMs: params.runAtMs, recordedAtMs },
    };
    await atomicWrite(path, next);
    return next;
  });
}

export async function finishImportantDateProjectedRun(params: {
  path?: string;
  jobId: string;
  runAtMs: number;
}): Promise<ImportantDateProjection> {
  const path = params.path ?? importantDateProjectionPath();
  return withLock(path, async () => {
    const current = await readImportantDateProjection(path);
    if (current.job.id !== params.jobId) return current;
    if (current.activeRun?.runAtMs !== params.runAtMs) return current;
    const next: ImportantDateProjection = { ...current, revision: current.revision + 1, activeRun: null };
    await atomicWrite(path, next);
    return next;
  });
}
