import { describe, expect, it, vi } from "vitest";
import {
  DAILY_REVIEW_DECLARATIONS,
  DAILY_REVIEW_GROUP_ID,
  TASK_DAILY_REVIEW_TOOL,
  buildDailyReviewScript,
  dailyReviewInternals,
  executeDailyReview,
} from "./daily-review.js";

const BOOTSTRAP = "2026-09-05T06:00:00.000Z";
const MORNING_MS = Date.parse("2026-09-05T06:30:00.000Z");

function task(id: number, createdAt: string) {
  return {
    id: `T-${id}`,
    numericId: id,
    title: `Task ${id}`,
    assignee: "Дубровин М.",
    dueDate: null,
    dueTime: null,
    projectId: null,
    projectTitle: null,
    projectStatus: null,
    createdAt,
    labels: [],
  };
}

function job(params: {
  id: string;
  peerId: string;
  declaration: string;
  expr: string;
  runningAtMs?: number;
}) {
  const groupParams = {
    group_id: DAILY_REVIEW_GROUP_ID,
    bootstrap_checkpoint: BOOTSTRAP,
    peer_job_id: params.peerId,
  } as const;
  return {
    id: params.id,
    declarationKey: params.declaration,
    agentId: "tasks",
    sessionTarget: "isolated",
    schedule: { kind: "cron", expr: params.expr, tz: "Europe/Moscow" },
    payload: {
      kind: "script",
      script: buildDailyReviewScript(groupParams),
      toolsAllow: [TASK_DAILY_REVIEW_TOOL],
    },
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "owner-chat",
      accountId: "tasks",
      bestEffort: false,
    },
    state: params.runningAtMs === undefined ? {} : { runningAtMs: params.runningAtMs },
  };
}

function fixture() {
  const current = job({
    id: "morning-job",
    peerId: "evening-job",
    declaration: DAILY_REVIEW_DECLARATIONS.morning,
    expr: "30 9 * * *",
    runningAtMs: MORNING_MS,
  });
  const peer = job({
    id: "evening-job",
    peerId: "morning-job",
    declaration: DAILY_REVIEW_DECLARATIONS.evening,
    expr: "0 17 * * *",
  });
  const readGateway = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "cron.get") return params.id === current.id ? current : peer;
    return {
      entries: [],
      total: 0,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    };
  });
  return { readGateway };
}

function dependencies(
  readGateway: ReturnType<typeof vi.fn>,
  runSemanticModel: ReturnType<typeof vi.fn>,
) {
  return {
    api: {} as never,
    toolContext: {
      agentId: "tasks",
      sessionKey: "agent:tasks:cron:morning-job:trigger",
    } as never,
    readGateway: readGateway as never,
    loadSnapshot: () => ({
      inboxCount: 0,
      tasks: [
        task(1, "2026-09-05T06:10:00.000Z"),
        task(2, "2026-09-05T05:00:00.000Z"),
      ],
    }),
    runSemanticModel,
  };
}

async function runReview(runSemanticModel: ReturnType<typeof vi.fn>) {
  const { readGateway } = fixture();
  return executeDailyReview(
    {
      group_id: DAILY_REVIEW_GROUP_ID,
      bootstrap_checkpoint: BOOTSTRAP,
      peer_job_id: "evening-job",
    },
    dependencies(readGateway, runSemanticModel) as never,
  );
}

describe("Daily Review semantic batch-local retry", () => {
  it("reserves capacity for one retry per semantic batch", () => {
    expect(() => dailyReviewInternals.assertSemanticCallCapacity(200)).not.toThrow();
    expect(() => dailyReviewInternals.assertSemanticCallCapacity(201)).toThrow(
      /requires up to 402 calls.*bounded limit 400/,
    );
  });

  it.each([
    [
      "candidate outside new_candidates",
      '{"pairs":[{"candidate_id":"T-999","other_id":"T-2"}]}',
    ],
    [
      "other outside open_population chunk",
      '{"pairs":[{"candidate_id":"T-1","other_id":"T-999"}]}',
    ],
    [
      "identical candidate and other IDs",
      '{"pairs":[{"candidate_id":"T-1","other_id":"T-1"}]}',
    ],
  ])("retries exactly once for %s", async (_caseName, invalidOutput) => {
    const model = vi
      .fn()
      .mockResolvedValueOnce(invalidOutput)
      .mockResolvedValueOnce('{"pairs":[{"candidate_id":"T-1","other_id":"T-2"}]}');

    const result = await runReview(model);

    expect(model).toHaveBeenCalledTimes(2);
    expect(result.semantic_calls).toBe(2);
    expect(result.duplicate_pair_count).toBe(1);
    expect(result.message).toContain("T-1 Task 1\nT-2 Task 2");

    const retryPrompt = String(model.mock.calls[1]?.[0]);
    expect(retryPrompt).toContain("Retry this semantic duplicate classification batch");
    expect(retryPrompt).toContain('Allowed candidate_id values: ["T-1"]');
    expect(retryPrompt).toContain('Allowed other_id values: ["T-1","T-2"]');
  });

  it("fails closed after one retry when the retry still escapes the batch", async () => {
    const model = vi
      .fn()
      .mockResolvedValueOnce('{"pairs":[{"candidate_id":"T-1","other_id":"T-999"}]}')
      .mockResolvedValueOnce('{"pairs":[{"candidate_id":"T-999","other_id":"T-2"}]}');

    await expect(runReview(model)).rejects.toThrow(/out-of-batch/);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("does not retry malformed JSON because it is not a batch-local ID violation", async () => {
    const model = vi.fn().mockResolvedValueOnce("not-json");

    await expect(runReview(model)).rejects.toThrow(/valid JSON/);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "null candidate_id",
      '{"pairs":[{"candidate_id":null,"other_id":"T-2"}]}',
    ],
    [
      "numeric other_id",
      '{"pairs":[{"candidate_id":"T-1","other_id":2}]}',
    ],
  ])("does not retry malformed ID field types: %s", async (_caseName, malformedOutput) => {
    const model = vi.fn().mockResolvedValueOnce(malformedOutput);

    await expect(runReview(model)).rejects.toThrow(/IDs must be strings/);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("does not retry provider or model execution failures", async () => {
    const model = vi.fn().mockRejectedValueOnce(new Error("provider timeout"));

    await expect(runReview(model)).rejects.toThrow(/provider timeout/);
    expect(model).toHaveBeenCalledTimes(1);
  });
});
