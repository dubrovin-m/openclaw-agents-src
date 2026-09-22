import { describe, expect, it, vi } from "vitest";
import {
  DAILY_REVIEW_DECLARATIONS,
  DAILY_REVIEW_GROUP_ID,
  TASK_DAILY_REVIEW_TOOL,
  buildDailyReviewScript,
  createDailyReviewTool,
  dailyReviewInternals,
  executeDailyReview,
} from "./daily-review.js";

const BOOTSTRAP = "2026-09-05T06:00:00.000Z";
const MORNING_MS = Date.parse("2026-09-05T06:30:00.000Z"); // 09:30 Moscow

function task(id: number, overrides: Record<string, unknown> = {}) {
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
    createdAt: "2026-09-05T06:10:00.000Z",
    labels: [],
    ...overrides,
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

function gatewayFixture(options?: {
  currentRuns?: unknown[];
  peerRuns?: unknown[];
  peerRunningAtMs?: number;
}) {
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
    runningAtMs: options?.peerRunningAtMs,
  });
  const readGateway = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "cron.get") return params.id === current.id ? current : peer;
    const entries =
      params.id === current.id ? (options?.currentRuns ?? []) : (options?.peerRuns ?? []);
    return {
      entries,
      total: entries.length,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    };
  });
  return { current, peer, readGateway };
}

function deps(
  readGateway: ReturnType<typeof vi.fn>,
  loadSnapshot: () => unknown[],
  runSemanticModel = vi.fn(async () => '{"pairs":[]}'),
  inboxCount = 0,
) {
  return {
    api: {} as never,
    toolContext: {
      agentId: "tasks",
      sessionKey: "agent:tasks:cron:morning-job:trigger",
    } as never,
    readGateway: readGateway as never,
    loadSnapshot: (() => ({ inboxCount, tasks: loadSnapshot() })) as never,
    runSemanticModel,
  };
}

describe("Daily Review scheduler authority", () => {
  it("materializes only inside the tasks cron trigger session", () => {
    expect(
      createDailyReviewTool(
        {} as never,
        { agentId: "tasks", sessionKey: "agent:tasks:main" } as never,
      ),
    ).toBeNull();
    expect(
      createDailyReviewTool(
        {} as never,
        { agentId: "main", sessionKey: "agent:main:cron:x:trigger" } as never,
      ),
    ).toBeNull();
    expect(
      createDailyReviewTool(
        {} as never,
        { agentId: "tasks", sessionKey: "agent:tasks:cron:job-1:trigger" } as never,
      )?.name,
    ).toBe(TASK_DAILY_REVIEW_TOOL);
  });

  it("builds a stable script with persisted group metadata", () => {
    expect(
      buildDailyReviewScript({
        group_id: DAILY_REVIEW_GROUP_ID,
        bootstrap_checkpoint: "2026-09-05T09:00:00+03:00",
        peer_job_id: "peer-1",
      }),
    ).toBe(
      'const review = await task_daily_review({"group_id":"tasks-daily-review-v1","bootstrap_checkpoint":"2026-09-05T06:00:00.000Z","peer_job_id":"peer-1"});\n' +
        'json(review.suppress ? {} : { notify: review.message });',
    );
  });

  it("uses only delivered successful native completion as checkpoint authority", () => {
    const checkpoint = dailyReviewInternals.resolveCheckpoint({
      currentHistory: [
        {
          status: "ok",
          completionStatus: "failed",
          delivered: false,
          deliveryStatus: "not-delivered",
          runAtMs: MORNING_MS - 1_000,
        },
        {
          status: "ok",
          completionStatus: "succeeded",
          delivered: false,
          deliveryStatus: "not-requested",
          runAtMs: MORNING_MS - 2_000,
        },
      ],
      peerHistory: [
        {
          status: "ok",
          completionStatus: "succeeded",
          delivered: true,
          deliveryStatus: "delivered",
          runAtMs: MORNING_MS - 3_000,
        },
      ],
      currentBoundaryMs: MORNING_MS,
      bootstrapMs: Date.parse(BOOTSTRAP),
    });
    expect(checkpoint).toBe(MORNING_MS - 3_000);
  });

  it("suppresses a retry after the same slot/date already delivered successfully", async () => {
    const fixture = gatewayFixture({
      currentRuns: [
        {
          status: "ok",
          completionStatus: "succeeded",
          delivered: true,
          deliveryStatus: "delivered",
          runAtMs: MORNING_MS - 60_000,
        },
      ],
    });
    const model = vi.fn(async () => '{"pairs":[]}');
    const result = await executeDailyReview(
      {
        group_id: DAILY_REVIEW_GROUP_ID,
        bootstrap_checkpoint: BOOTSTRAP,
        peer_job_id: "evening-job",
      },
      deps(fixture.readGateway, () => [task(1)], model) as never,
    );
    expect(result.suppress).toBe(true);
    expect(model).not.toHaveBeenCalled();
  });

  it("fails closed when an earlier peer group occurrence is active", async () => {
    const fixture = gatewayFixture({ peerRunningAtMs: MORNING_MS - 1 });
    await expect(
      executeDailyReview(
        {
          group_id: DAILY_REVIEW_GROUP_ID,
          bootstrap_checkpoint: BOOTSTRAP,
          peer_job_id: "evening-job",
        },
        deps(fixture.readGateway, () => []) as never,
      ),
    ).rejects.toThrow(/already active/);
  });

  it("uses the in-process plugin Gateway runtime for native Automation reads", async () => {
    const fixture = gatewayFixture();
    const request = vi.fn(async (method: string, params: Record<string, unknown>) =>
      fixture.readGateway(method, params),
    );
    const result = await executeDailyReview(
      {
        group_id: DAILY_REVIEW_GROUP_ID,
        bootstrap_checkpoint: BOOTSTRAP,
        peer_job_id: "evening-job",
      },
      {
        api: {
          runtime: {
            gateway: { isAvailable: vi.fn(async () => true), request },
          },
        } as never,
        toolContext: {
          agentId: "tasks",
          sessionKey: "agent:tasks:cron:morning-job:trigger",
        } as never,
        loadSnapshot: () => ({ inboxCount: 0, tasks: [] }),
        runSemanticModel: vi.fn(async () => '{"pairs":[]}'),
      },
    );
    expect(result.message).toBe("📥 INBOX 0\n\nНа сегодня задач нет.");
    expect(request).toHaveBeenCalledWith("cron.get", { id: "morning-job" }, { timeoutMs: 12_000 });
    expect(request).toHaveBeenCalledWith("cron.get", { id: "evening-job" }, { timeoutMs: 12_000 });
    expect(request).toHaveBeenCalledWith(
      "cron.runs",
      { id: "morning-job", limit: 200, offset: 0, sortDir: "desc" },
      { timeoutMs: 12_000 },
    );
  });
});

describe("Daily Review candidate windows and semantic batching", () => {
  it("does not call the semantic model when there are no new OPEN candidates", async () => {
    const fixture = gatewayFixture({
      peerRuns: [
        {
          status: "ok",
          completionStatus: "succeeded",
          delivered: true,
          deliveryStatus: "delivered",
          runAtMs: Date.parse("2026-09-05T06:20:00.000Z"),
        },
      ],
    });
    const model = vi.fn(async () => '{"pairs":[]}');
    const result = await executeDailyReview(
      {
        group_id: DAILY_REVIEW_GROUP_ID,
        bootstrap_checkpoint: BOOTSTRAP,
        peer_job_id: "evening-job",
      },
      deps(
        fixture.readGateway,
        () => [task(1, { createdAt: "2026-09-05T06:19:59.000Z" })],
        model,
      ) as never,
    );
    expect(result.candidate_count).toBe(0);
    expect(result.semantic_calls).toBe(0);
    expect(model).not.toHaveBeenCalled();
  });

  it("keeps a task created after the snapshot boundary out of the current candidate window", async () => {
    const fixture = gatewayFixture();
    const model = vi.fn(async () => '{"pairs":[]}');
    const result = await executeDailyReview(
      {
        group_id: DAILY_REVIEW_GROUP_ID,
        bootstrap_checkpoint: BOOTSTRAP,
        peer_job_id: "evening-job",
      },
      deps(
        fixture.readGateway,
        () => [task(1, { createdAt: "2026-09-05T06:30:00.001Z" })],
        model,
      ) as never,
    );
    expect(result.candidate_count).toBe(0);
    expect(model).not.toHaveBeenCalled();
  });

  it("does not silently truncate an OPEN population larger than 200 tasks", async () => {
    const fixture = gatewayFixture();
    const snapshot = Array.from({ length: 250 }, (_, index) =>
      task(index + 1, {
        createdAt:
          index === 0 ? "2026-09-05T06:10:00.000Z" : "2026-09-05T05:00:00.000Z",
      }),
    );
    const model = vi.fn(async () => '{"pairs":[]}');
    const result = await executeDailyReview(
      {
        group_id: DAILY_REVIEW_GROUP_ID,
        bootstrap_checkpoint: BOOTSTRAP,
        peer_job_id: "evening-job",
      },
      deps(fixture.readGateway, () => snapshot, model) as never,
    );
    expect(result.candidate_count).toBe(1);
    expect(model).toHaveBeenCalled();
    expect(
      model.mock.calls.some(([prompt]) => String(prompt).includes('"id":"T-250"')),
    ).toBe(true);
  });

  it("fails the review when semantic output is invalid instead of claiming no duplicates", async () => {
    const fixture = gatewayFixture();
    await expect(
      executeDailyReview(
        {
          group_id: DAILY_REVIEW_GROUP_ID,
          bootstrap_checkpoint: BOOTSTRAP,
          peer_job_id: "evening-job",
        },
        deps(
          fixture.readGateway,
          () => [
            task(1),
            task(2, { createdAt: "2026-09-05T05:00:00.000Z" }),
          ],
          vi.fn(async () => "not-json"),
        ) as never,
      ),
    ).rejects.toThrow(/valid JSON/);
  });

  it("rejects model pairs that invent or escape the bounded batch", () => {
    expect(() =>
      dailyReviewInternals.parseSemanticPairs(
        '{"pairs":[{"candidate_id":"T-1","other_id":"T-999"}]}',
        new Set(["T-1"]),
        new Set(["T-2"]),
      ),
    ).toThrow(/out-of-batch/);
  });
});

describe("Daily Review deterministic presentation", () => {
  it("returns the exact empty-review text", () => {
    expect(dailyReviewInternals.renderReview([], [], MORNING_MS)).toBe("На сегодня задач нет.");
  });

  it("prepends Inbox count only for the morning review, including zero", () => {
    expect(dailyReviewInternals.reviewInboxCount(DAILY_REVIEW_DECLARATIONS.morning, 7)).toBe(7);
    expect(dailyReviewInternals.reviewInboxCount(DAILY_REVIEW_DECLARATIONS.evening, 7)).toBeUndefined();
    expect(dailyReviewInternals.renderReview([], [], MORNING_MS, 0)).toBe(
      "📥 INBOX 0\n\nНа сегодня задач нет.",
    );
    expect(dailyReviewInternals.renderReview([], [], MORNING_MS, 7)).toBe(
      "📥 INBOX 7\n\nНа сегодня задач нет.",
    );
  });

  it("keeps a due-today task in Today even after its due_time has passed", () => {
    expect(
      dailyReviewInternals.primaryBucket(
        task(4, { dueDate: "2026-09-05", dueTime: "08:00" }) as never,
        "2026-09-05",
        "09:30",
      ),
    ).toBe(1);
  });

  it("renders the approved overdue / Office CEO / Team / Personal mask", () => {
    const rows = [
      task(3, {
        title: "Team today",
        assignee: "Иванов И.",
        dueDate: "2026-09-05",
        dueTime: "08:00",
        labels: [{ id: "L-2", displayName: "Work", emoji: "💼" }],
        officeCeo: false,
        personal: false,
        pendingDeadlineChangeRequest: null,
      }),
      task(4, {
        title: "Office today",
        dueDate: "2026-09-05",
        labels: [],
        officeCeo: true,
        personal: false,
        pendingDeadlineChangeRequest: null,
      }),
      task(5, {
        title: "Personal today",
        dueDate: "2026-09-05",
        dueTime: "19:00",
        labels: [{ id: "L-1", displayName: "Home", emoji: "🏠" }],
        officeCeo: true,
        personal: true,
        pendingDeadlineChangeRequest: null,
      }),
      task(2, {
        title: "Overdue B",
        assignee: "Иванов И.",
        dueDate: "2026-09-04",
        labels: [],
        officeCeo: false,
        personal: false,
        pendingDeadlineChangeRequest: { requestedDueDate: "2026-09-10", requestedDueTime: null },
      }),
      task(1, {
        title: "Overdue A",
        assignee: "Дубровин М.",
        dueDate: "2026-09-03",
        labels: [],
        officeCeo: true,
        personal: false,
        pendingDeadlineChangeRequest: null,
      }),
      task(6, {
        title: "Overdue remove deadline",
        assignee: "Сидоров С.",
        dueDate: "2026-09-02",
        labels: [],
        officeCeo: false,
        personal: false,
        pendingDeadlineChangeRequest: { requestedDueDate: null, requestedDueTime: null },
      }),
    ];
    const rendered = dailyReviewInternals.renderReview(rows as never, [], MORNING_MS);
    expect(rendered).toContain("🔴 ПРОСРОЧЕНО 3");
    expect(rendered).toContain("💼 СЕГОДНЯ · ОФИС CEO 1");
    expect(rendered).toContain("📌 СЕГОДНЯ · КОМАНДА 1");
    expect(rendered).toContain("🏠 СЕГОДНЯ · ЛИЧНОЕ 1");
    expect(rendered).toContain("T-2 Overdue B\nИванов И. · 4 сен · ↪ 10 сен на согласовании");
    expect(rendered).toContain("T-6 Overdue remove deadline\nСидоров С. · 2 сен · ↪ без срока на согласовании");
    expect(rendered).toContain("T-3 💼 Team today\nИванов И. · 08:00");
    expect(rendered).toContain("T-4 Office today\nДубровин М.");
    expect(rendered).toContain("T-5 🏠 Personal today\n19:00");
    expect(rendered).not.toContain("сегодня ·");
  });

  it("adds duplicate warnings without mutating or rewriting Task titles", () => {
    const rows = [
      task(44, { title: "Подготовить проект решения по оргструктуре" }),
      task(51, { title: "Сделать драфт решения по изменению оргструктуры" }),
    ];
    const rendered = dailyReviewInternals.renderReview(
      rows as never,
      [{ firstId: "T-44", secondId: "T-51" }],
      MORNING_MS,
    );
    expect(rendered).toContain("Возможные дубли");
    expect(rendered).toContain(
      "T-44 Подготовить проект решения по оргструктуре\nT-51 Сделать драфт решения по изменению оргструктуры",
    );
    expect(rendered).toContain("Похоже, задачи могут описывать одно обязательство.");
  });
});
