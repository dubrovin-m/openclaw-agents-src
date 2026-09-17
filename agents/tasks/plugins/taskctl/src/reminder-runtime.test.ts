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

function fixture() {
  const controller = new AbortController();
  const job = {
    id: "job-1",
    declarationKey: REMINDER_DISPATCH_DECLARATION,
    agentId: "tasks",
    enabled: true,
    schedule: { kind: "cron", expr: REMINDER_DISPATCH_CRON, tz: REMINDER_TIMEZONE, staggerMs: 0 },
    sessionTarget: "isolated",
    payload: { kind: "script", script: buildReminderDispatchScript(), toolsAllow: [TASK_REMINDER_DISPATCH_TOOL] },
    delivery: { mode: "announce", channel: "telegram", accountId: "tasks", to: "test-owner", bestEffort: false },
    state: { runningAtMs: Date.parse("2026-09-16T09:00:00.000Z") },
  };
  const service = { list: vi.fn(async () => [job]) };
  const hooks = new Map<string, Hook>();
  const api = {
    config: { channels: { telegram: { accounts: { tasks: { allowFrom: ["test-owner"] } } } } },
    on: (name: string, handler: Hook) => { hooks.set(name, handler); },
  };
  registerReminderRuntime(api as never);
  hooks.get("cron_reconciled")?.({ enabled: true }, { getCron: () => service, abortSignal: controller.signal });
  return { controller, job, service, hooks };
}

beforeEach(() => {
  runInternal.mockReset();
  reminderRuntimeInternals.resetState();
});

describe("Reminder scheduler runtime", () => {
  it("builds one bounded scheduler script", () => {
    expect(buildReminderDispatchScript()).toBe([
      "const dispatch = await task_reminder_dispatch({});",
      "json(dispatch.count > 0 ? { notify: dispatch.message } : {});",
    ].join("\n"));
  });

  it("exposes the scheduler-only tool only to tasks cron sessions and validates the registered job", async () => {
    const { service } = fixture();
    expect(createReminderDispatchTool({ agentId: "tasks", sessionKey: "agent:tasks:main" } as never)).toBeNull();
    expect(createReminderDispatchTool({ agentId: "main", sessionKey: "agent:main:cron:job-1:trigger" } as never)).toBeNull();
    expect(createReminderDispatchTool({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never)).not.toBeNull();

    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "🔔 Напоминание: Тест" } as never);
    const result = await executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never);
    expect(result).toMatchObject({ count: 1, message: "🔔 Напоминание: Тест" });
    expect(service.list).toHaveBeenCalled();
    expect(runInternal).toHaveBeenCalledWith("dispatch", {
      claim_token: "reminder:job-1:1789549200000",
      boundary: "2026-09-16T09:00:00.000Z",
    }, { signal: undefined });
  });

  it("fails closed when the persisted dispatcher delivery destination drifts", async () => {
    const { job } = fixture();
    job.delivery.to = "wrong-owner";
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "must not send" } as never);
    await expect(executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never))
      .rejects.toThrow("delivery route drift");
    expect(runInternal).not.toHaveBeenCalled();
  });

  it("revalidates the exact persisted delivery destination immediately before send", async () => {
    const { hooks, job } = fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "stale" } as never);
    await executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never);
    job.delivery.to = "wrong-owner";
    const result = await hooks.get("reply_payload_sending")?.(
      { payload: { text: "stale" }, sessionKey: "agent:tasks:cron:job-1:trigger" },
      { channelId: "telegram", accountId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" },
    );
    expect(result).toEqual({ cancel: true, reason: "reminder_pre_send_revalidation_failed" });
    expect(runInternal).toHaveBeenCalledTimes(1);
  });

  it("re-renders the claimed payload immediately before Telegram send", async () => {
    const { hooks } = fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "stale" } as never);
    await executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never);

    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "🔔 Напоминание: Актуальный текст" } as never);
    const result = await hooks.get("reply_payload_sending")?.(
      { payload: { text: "stale" }, sessionKey: "agent:tasks:cron:job-1:trigger" },
      { channelId: "telegram", accountId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" },
    );
    expect(result).toEqual({ payload: { text: "🔔 Напоминание: Актуальный текст" } });
    expect(runInternal).toHaveBeenLastCalledWith("render", { claim_token: "reminder:job-1:1789549200000" });
  });

  it("suppresses outbound delivery when the claim no longer contains an ACTIVE Reminder", async () => {
    const { hooks } = fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "stale" } as never);
    await executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never);
    runInternal.mockResolvedValueOnce({ ok: true, count: 0, message: "" } as never);
    const result = await hooks.get("reply_payload_sending")?.(
      { payload: { text: "stale" }, sessionKey: "agent:tasks:cron:job-1:trigger" },
      { channelId: "telegram", accountId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" },
    );
    expect(result).toEqual({ cancel: true, reason: "reminder_claim_no_longer_active" });
  });

  it("fails closed on delivery-route drift", async () => {
    const { hooks } = fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "stale" } as never);
    await executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never);
    const result = await hooks.get("reply_payload_sending")?.(
      { payload: { text: "stale" }, sessionKey: "agent:tasks:cron:job-1:trigger" },
      { channelId: "telegram", accountId: "main", sessionKey: "agent:tasks:cron:job-1:trigger" },
    );
    expect(result).toEqual({ cancel: true, reason: "reminder_delivery_route_mismatch" });
  });

  it("settles only confirmed delivery success and releases failed delivery", async () => {
    const { hooks } = fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "message" } as never);
    await executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never);
    runInternal.mockResolvedValueOnce({ ok: true, count: 1 } as never);
    await hooks.get("cron_changed")?.({
      action: "finished", jobId: "job-1", runAtMs: Date.parse("2026-09-16T09:00:00.000Z"),
      completionStatus: "succeeded", delivered: true, deliveryStatus: "delivered",
    });
    expect(runInternal).toHaveBeenLastCalledWith("settle", { claim_token: "reminder:job-1:1789549200000", delivered: true });

    const { hooks: hooks2 } = fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "message" } as never);
    await executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never);
    runInternal.mockResolvedValueOnce({ ok: true, count: 1 } as never);
    await hooks2.get("cron_changed")?.({
      action: "finished", jobId: "job-1", runAtMs: Date.parse("2026-09-16T09:00:00.000Z"),
      completionStatus: "failed", delivered: false, deliveryStatus: "failed",
    });
    expect(runInternal).toHaveBeenLastCalledWith("settle", { claim_token: "reminder:job-1:1789549200000", delivered: false });
  });

  it("cancels when concurrent claim identity would be ambiguous", async () => {
    const { hooks, job } = fixture();
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "one" } as never);
    await executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never);
    job.state.runningAtMs += 60_000;
    runInternal.mockResolvedValueOnce({ ok: true, count: 1, message: "two" } as never);
    await executeReminderDispatch({ agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never);
    const result = await hooks.get("reply_payload_sending")?.(
      { payload: { text: "unknown" }, sessionKey: "agent:tasks:cron:job-1:trigger" },
      { channelId: "telegram", accountId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" },
    );
    expect(result).toEqual({ cancel: true, reason: "reminder_claim_identity_ambiguous" });
  });
});
