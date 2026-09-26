import { describe, expect, it, vi } from "vitest";
import { DAILY_REVIEW_DECLARATIONS } from "./daily-review.js";
import {
  DAILY_REVIEW_CLI_COMMAND,
  dailyReviewRuntimeInternals,
  executeDailyReviewCommand,
  registerDailyReviewCli,
} from "./daily-review-runtime.js";

const OPENCLAW_BIN = "/opt/openclaw/bin/openclaw";
const CREATED_MORNING = Date.parse("2026-09-07T17:40:06.320Z");
const CREATED_EVENING = Date.parse("2026-09-07T17:40:16.801Z");
const BOUNDARY_MS = Date.parse("2026-09-26T06:30:00.050Z");
const PREVIOUS_MORNING_MS = Date.parse("2026-09-25T06:30:00.030Z");
const PREVIOUS_EVENING_MS = Date.parse("2026-09-25T14:00:00.040Z");

type Run = {
  runAtMs: number;
  status: string;
  completionStatus: string;
  delivered: boolean;
  deliveryStatus: string;
};

function delivered(runAtMs: number): Run {
  return {
    runAtMs,
    status: "ok",
    completionStatus: "succeeded",
    delivered: true,
    deliveryStatus: "delivered",
  };
}

function job(options: {
  id: string;
  declarationKey: string;
  name: string;
  description: string;
  expr: string;
  createdAtMs: number;
  runningAtMs?: number;
}) {
  return {
    id: options.id,
    declarationKey: options.declarationKey,
    name: options.name,
    description: options.description,
    enabled: true,
    agentId: "tasks",
    createdAtMs: options.createdAtMs,
    schedule: { kind: "cron", expr: options.expr, tz: "Europe/Moscow", staggerMs: 0 },
    sessionTarget: "isolated",
    payload: {
      kind: "command",
      argv: dailyReviewRuntimeInternals.expectedCommandArgv(
        OPENCLAW_BIN,
        options.declarationKey as never,
      ),
      timeoutSeconds: 300,
    },
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "owner",
      accountId: "tasks",
      bestEffort: false,
    },
    state: { runningAtMs: options.runningAtMs },
  };
}

function pair() {
  return [
    job({
      id: "morning-job",
      declarationKey: DAILY_REVIEW_DECLARATIONS.morning,
      name: "tasks-daily-review-morning",
      description: "Task Agent Scheduled Daily Review — 09:30 Europe/Moscow",
      expr: "30 9 * * *",
      createdAtMs: CREATED_MORNING,
      runningAtMs: BOUNDARY_MS,
    }),
    job({
      id: "evening-job",
      declarationKey: DAILY_REVIEW_DECLARATIONS.evening,
      name: "tasks-daily-review-evening",
      description: "Task Agent Scheduled Daily Review — 17:00 Europe/Moscow",
      expr: "0 17 * * *",
      createdAtMs: CREATED_EVENING,
    }),
  ];
}

function scheduler(
  jobs = pair(),
  runs: Record<string, Run[]> = {
    "morning-job": [delivered(PREVIOUS_MORNING_MS)],
    "evening-job": [delivered(PREVIOUS_EVENING_MS)],
  },
) {
  const calls: string[][] = [];
  const readScheduler = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] !== "automations") throw new Error("unexpected root command");
    if (args[1] === "list") return { jobs };
    if (args[1] === "get") {
      const found = jobs.find((entry) => entry.id === args[2]);
      if (!found) throw new Error("unknown job");
      return structuredClone(found);
    }
    if (args[1] === "runs") {
      const id = args[2]!;
      const limit = Number(args[args.indexOf("--limit") + 1]);
      const offset = Number(args[args.indexOf("--offset") + 1]);
      const entries = (runs[id] ?? []).slice(offset, offset + limit);
      const nextOffset = offset + entries.length;
      return {
        entries,
        total: (runs[id] ?? []).length,
        offset,
        limit,
        hasMore: nextOffset < (runs[id] ?? []).length,
        nextOffset: nextOffset < (runs[id] ?? []).length ? nextOffset : null,
      };
    }
    throw new Error(`unexpected scheduler command: ${args.join(" ")}`);
  });
  return { readScheduler, calls, jobs, runs };
}

async function runWith(
  state: ReturnType<typeof scheduler>,
  loadSnapshot = vi.fn(async () => ({ inboxCount: 0, tasks: [] })),
) {
  return executeDailyReviewCommand(
    { config: {} } as never,
    {
      declarationKey: DAILY_REVIEW_DECLARATIONS.morning,
      openclawBin: OPENCLAW_BIN,
    },
    {
      readScheduler: state.readScheduler,
      loadSnapshot,
      runSemanticModel: vi.fn(async () => '{"pairs":[]}'),
    },
  );
}

describe("Daily Review native command runtime", () => {
  it("runs without any Gateway-side module-global scheduler binding and derives checkpoint from native delivered history", async () => {
    const state = scheduler();
    const result = await runWith(state);
    expect(result.suppress).toBe(false);
    expect(result.previous_successful_checkpoint).toBe(new Date(PREVIOUS_EVENING_MS).toISOString());
    expect(result.snapshot_boundary).toBe(new Date(BOUNDARY_MS).toISOString());
    expect(state.calls.some((args) => args[1] === "runs" && args[2] === "morning-job")).toBe(true);
    expect(state.calls.some((args) => args[1] === "runs" && args[2] === "evening-job")).toBe(true);
  });

  it("does not advance checkpoint for execution success when required delivery failed", async () => {
    const state = scheduler(pair(), {
      "morning-job": [delivered(PREVIOUS_MORNING_MS)],
      "evening-job": [
        {
          runAtMs: PREVIOUS_EVENING_MS,
          status: "ok",
          completionStatus: "succeeded",
          delivered: false,
          deliveryStatus: "not-delivered",
        },
      ],
    });
    const result = await runWith(state);
    expect(result.previous_successful_checkpoint).toBe(new Date(PREVIOUS_MORNING_MS).toISOString());
  });

  it("suppresses a duplicate retry for the same schedule slot and Moscow date", async () => {
    const sameOccurrence = BOUNDARY_MS - 60_000;
    const state = scheduler(pair(), {
      "morning-job": [delivered(sameOccurrence), delivered(PREVIOUS_MORNING_MS)],
      "evening-job": [delivered(PREVIOUS_EVENING_MS)],
    });
    const snapshot = vi.fn(async () => ({ inboxCount: 0, tasks: [] }));
    const result = await runWith(state, snapshot);
    expect(result.suppress).toBe(true);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("establishes runningAtMs as snapshot boundary before Task retrieval", async () => {
    const state = scheduler();
    const snapshot = vi.fn(async (boundaryIso: string) => {
      expect(boundaryIso).toBe(new Date(BOUNDARY_MS).toISOString());
      expect(state.calls.some((args) => args[1] === "get" && args[2] === "morning-job")).toBe(true);
      expect(state.calls.some((args) => args[1] === "runs")).toBe(true);
      return { inboxCount: 0, tasks: [] };
    });
    await runWith(state, snapshot);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("fails closed on invalid boundary and target command drift", async () => {
    const missingBoundary = pair();
    missingBoundary[0]!.state.runningAtMs = undefined;
    await expect(runWith(scheduler(missingBoundary))).rejects.toThrow(/runningAtMs snapshot boundary/);

    const drifted = pair();
    drifted[1]!.payload.argv = [OPENCLAW_BIN, "unexpected"];
    await expect(runWith(scheduler(drifted))).rejects.toThrow(/command payload drift/);
  });

  it("cannot be regressed by an older terminal run because checkpoint is selected from immutable history", async () => {
    const older = delivered(PREVIOUS_MORNING_MS - 86_400_000);
    const newer = delivered(PREVIOUS_EVENING_MS);
    const state = scheduler(pair(), {
      "morning-job": [older],
      "evening-job": [newer],
    });
    const first = await runWith(state);
    state.runs["morning-job"] = [older, delivered(PREVIOUS_MORNING_MS - 1)];
    const second = await runWith(state);
    expect(first.previous_successful_checkpoint).toBe(new Date(PREVIOUS_EVENING_MS).toISOString());
    expect(second.previous_successful_checkpoint).toBe(new Date(PREVIOUS_EVENING_MS).toISOString());
  });

  it("uses scheduler-owned createdAtMs as first-run activation checkpoint", async () => {
    const state = scheduler(pair(), { "morning-job": [], "evening-job": [] });
    const result = await runWith(state);
    expect(result.previous_successful_checkpoint).toBe(new Date(CREATED_MORNING).toISOString());
  });

  it("survives independent CLI process generations because all checkpoint inputs are native scheduler data", async () => {
    const firstState = scheduler();
    const secondState = scheduler(structuredClone(firstState.jobs), structuredClone(firstState.runs));
    const first = await runWith(firstState);
    const second = await runWith(secondState);
    expect(second.previous_successful_checkpoint).toBe(first.previous_successful_checkpoint);
    expect(second.snapshot_boundary).toBe(first.snapshot_boundary);
  });

  it("registers only a CLI runtime seam rather than a Gateway service bridge", () => {
    const descriptors: unknown[] = [];
    const api = {
      registerCli: vi.fn((_registrar, options) => descriptors.push(options)),
      registerService: vi.fn(),
      on: vi.fn(),
    };
    registerDailyReviewCli(api as never);
    expect(api.registerCli).toHaveBeenCalledTimes(1);
    expect(api.registerService).not.toHaveBeenCalled();
    expect(JSON.stringify(descriptors)).toContain(DAILY_REVIEW_CLI_COMMAND);
  });
});