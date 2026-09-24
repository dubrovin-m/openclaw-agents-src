import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./index.js", () => ({ runReminderInternal: vi.fn() }));

import { runReminderInternal } from "./index.js";
import {
  REMINDER_DISPATCH_CRON,
  REMINDER_DISPATCH_DECLARATION,
  REMINDER_TIMEZONE,
  TASK_REMINDER_DISPATCH_TOOL,
  buildReminderDispatchScript,
  createReminderDispatchTool,
  executeReminderDispatch,
  registerReminderRuntime,
  reminderRuntimeInternals,
} from "./reminder-runtime.js";

const runInternal = vi.mocked(runReminderInternal);

type Hook = (...args: any[]) => any;
type StateValue = {
  kind: "dispatcher" | "run";
  jobId: string;
  expectedRecipient: string;
  runAtMs?: number;
  projectedAtMs?: number;
};

class MemoryStore {
  readonly values = new Map<string, StateValue>();

  async register(key: string, value: StateValue) {
    this.values.set(key, structuredClone(value));
  }

  async lookup(key: string) {
    const value = this.values.get(key);
    return value ? structuredClone(value) : undefined;
  }

  async delete(key: string) {
    return this.values.delete(key);
  }

  async clear() {
    this.values.clear();
  }
}

function registration(store: MemoryStore, service: any) {
  const hooks = new Map<string, Hook>();
  const config = { channels: { telegram: { accounts: { tasks: { allowFrom: ["test-owner"] } } } } };
  const api = {
    config,
    runtime: { state: { openKeyedStore: () => store } },
    on: (name: string, handler: Hook) => { hooks.set(name, handler); },
  };
  registerReminderRuntime(api as never);
  return { hooks, config, context: { getCron: () => service, config } };
}

async function fixture(options: { start?: boolean } = {}) {
  const runAtMs = Date.now();
  const job = {
    id: "job-1",
    declarationKey: REMINDER_DISPATCH_DECLARATION,
    agentId: "tasks",
    enabled: true,
    schedule: { kind: "cron", expr: REMINDER_DISPATCH_CRON, tz: REMINDER_TIMEZONE, staggerMs: 0 },
    sessionTarget: "isolated",
    payload: { kind: "script", script: buildReminderDispatchScript(), toolsAllow: [TASK_REMINDER_DISPATCH_TOOL] },
    delivery: { mode: "announce", channel: "telegram", accountId: "tasks", to: "test-owner" },
    state: { runningAtMs: runAtMs },
  };
  const service = { list: vi.fn(async () => [job]) };
  const store = new MemoryStore();
  const gateway = registration(store, service);
  await gateway.hooks.get("cron_reconciled")?.(
    { enabled: true },
    { ...gateway.context, abortSignal: new AbortController().signal },
  );
  const start = async () => gateway.hooks.get("cron_changed")?.(
    { action: "started", jobId: job.id, runAtMs: job.state.runningAtMs },
    gateway.context,
  );
  if (options.start !== false) await start();
  return { runAtMs, job, service, store, start, ...gateway };
}

beforeEach(() => {
  runInternal.mockReset();
  reminderRuntimeInternals.resetLocalState();
});

describe("Reminder scheduler runtime", () => {
  it("builds one bounded scheduler script", () => {
    expect(buildReminderDispatchScript()).toBe([
      "const dispatch = await task_reminder_dispatch({});",
      "json(dispatch.count > 0 ? { notify: dispatch.message } : {});",
    ].join("\n"));
  });

  it("bridges Gateway lifecycle state into a fresh plugin registration", async () => {
    const fx = await fixture();
    reminderRuntimeInternals.resetLocalState();
    registration(fx.store, fx.service);

    expect(createReminderDispatchTool({ agentId: "tasks", sessionKey: "agent:tasks:main" } as never)).toBeNull();
    expect(createReminderDispatchTool({ agentId: "main", sessionKey: "agent:main:cron:job-1:trigger" } as never)).toBeNull();
    expect(createReminderDispatchTool({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never)).not.toBeNull();

    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "🔔 Напоминание: Тест" } as never);
    const result = await executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { now: () => fx.runAtMs },
    );
    expect(result).toMatchObject({ count: 1, message: "🔔 Напоминание: Тест" });
    expect(runInternal).toHaveBeenCalledWith("dispatch", {
      claim_token: "reminder:job-1:" + fx.runAtMs,
      boundary: new Date(fx.runAtMs).toISOString(),
    }, { signal: undefined });
  });

  it("fails closed when dispatcher delivery drifts before run admission", async () => {
    const fx = await fixture({ start: false });
    fx.job.delivery.to = "wrong-owner";
    await fx.start();

    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "must not send" } as never);
    await expect(executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { waitMs: 0, now: () => fx.runAtMs },
    )).rejects.toThrow("projection is unavailable or stale");
    expect(runInternal).not.toHaveBeenCalled();
  });

  it.each([true, null, 0, "true"])("fails closed for malformed or best-effort persisted delivery: %p", async (value) => {
    const fx = await fixture({ start: false });
    (fx.job.delivery as { bestEffort?: unknown }).bestEffort = value;
    await fx.start();

    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "must not send" } as never);
    await expect(executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { waitMs: 0, now: () => fx.runAtMs },
    )).rejects.toThrow("projection is unavailable or stale");
    expect(runInternal).not.toHaveBeenCalled();
  });

  it("fails closed before send when the admitted dispatcher projection is lost", async () => {
    const fx = await fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "stale" } as never);
    await executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { now: () => fx.runAtMs },
    );

    await fx.store.delete(reminderRuntimeInternals.dispatcherProjectionKey("job-1"));
    const result = await fx.hooks.get("reply_payload_sending")?.(
      { payload: { text: "stale" }, sessionKey: "agent:tasks:cron:job-1:trigger" },
      { channelId: "telegram", accountId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" },
    );
    expect(result).toEqual({ cancel: true, reason: "reminder_pre_send_revalidation_failed" });
  });

  it("re-renders the claimed payload immediately before Telegram send", async () => {
    const fx = await fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "stale" } as never);
    await executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { now: () => fx.runAtMs },
    );

    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "🔔 Напоминание: Актуальный текст" } as never);
    const result = await fx.hooks.get("reply_payload_sending")?.(
      { payload: { text: "stale" }, sessionKey: "agent:tasks:cron:job-1:trigger" },
      { channelId: "telegram", accountId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" },
    );
    expect(result).toEqual({ payload: { text: "🔔 Напоминание: Актуальный текст" } });
    expect(runInternal).toHaveBeenLastCalledWith("render", { claim_token: "reminder:job-1:" + fx.runAtMs });
  });

  it("suppresses outbound delivery when the claim no longer contains an ACTIVE Reminder", async () => {
    const fx = await fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "stale" } as never);
    await executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { now: () => fx.runAtMs },
    );

    runInternal.mockResolvedValueOnce({ ok: true, count: 0, message: "" } as never);
    const result = await fx.hooks.get("reply_payload_sending")?.(
      { payload: { text: "stale" }, sessionKey: "agent:tasks:cron:job-1:trigger" },
      { channelId: "telegram", accountId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" },
    );
    expect(result).toEqual({ cancel: true, reason: "reminder_claim_no_longer_active" });
  });

  it("fails closed on delivery-route mismatch", async () => {
    const fx = await fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "stale" } as never);
    await executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { now: () => fx.runAtMs },
    );

    const result = await fx.hooks.get("reply_payload_sending")?.(
      { payload: { text: "stale" }, sessionKey: "agent:tasks:cron:job-1:trigger" },
      { channelId: "telegram", accountId: "main", sessionKey: "agent:tasks:cron:job-1:trigger" },
    );
    expect(result).toEqual({ cancel: true, reason: "reminder_delivery_route_mismatch" });
  });

  it("settles only confirmed delivery success and releases failed delivery", async () => {
    const success = await fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "message" } as never);
    await executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { now: () => success.runAtMs },
    );
    runInternal.mockResolvedValueOnce({ ok: true, count: 1 } as never);
    await success.hooks.get("cron_changed")?.({
      action: "finished", jobId: "job-1", runAtMs: success.runAtMs,
      completionStatus: "succeeded", delivered: true, deliveryStatus: "delivered",
    }, success.context);
    expect(runInternal).toHaveBeenLastCalledWith("settle", {
      claim_token: "reminder:job-1:" + success.runAtMs,
      delivered: true,
    });

    const failed = await fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "message" } as never);
    await executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { now: () => failed.runAtMs },
    );
    runInternal.mockResolvedValueOnce({ ok: true, count: 1 } as never);
    await failed.hooks.get("cron_changed")?.({
      action: "finished", jobId: "job-1", runAtMs: failed.runAtMs,
      completionStatus: "failed", delivered: false, deliveryStatus: "failed",
    }, failed.context);
    expect(runInternal).toHaveBeenLastCalledWith("settle", {
      claim_token: "reminder:job-1:" + failed.runAtMs,
      delivered: false,
    });
  });

  it("does not settle a superseded run projection", async () => {
    const fx = await fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "one" } as never);
    await executeReminderDispatch(
      { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      { now: () => fx.runAtMs },
    );

    const secondRunAt = fx.runAtMs + 60_000;
    fx.job.state.runningAtMs = secondRunAt;
    await fx.hooks.get("cron_changed")?.(
      { action: "started", jobId: "job-1", runAtMs: secondRunAt },
      fx.context,
    );

    runInternal.mockClear();
    await fx.hooks.get("cron_changed")?.({
      action: "finished", jobId: "job-1", runAtMs: fx.runAtMs,
      completionStatus: "failed", delivered: false, deliveryStatus: "failed",
    }, fx.context);
    expect(runInternal).not.toHaveBeenCalled();
  });
});
