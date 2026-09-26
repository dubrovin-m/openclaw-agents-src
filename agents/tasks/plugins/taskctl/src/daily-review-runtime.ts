import { execFile } from "node:child_process";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  DAILY_REVIEW_DECLARATIONS,
  DAILY_REVIEW_GROUP_ID,
  TASK_DAILY_REVIEW_TOOL,
  buildDailyReviewScript,
  executeDailyReview,
} from "./daily-review.js";

export const DAILY_REVIEW_CLI_COMMAND = "taskctl-runtime";
const DAILY_REVIEW_AGENT_ID = "tasks";
const DAILY_REVIEW_TIMEZONE = "Europe/Moscow";
const COMMAND_TIMEOUT_SECONDS = 300;
const CLI_READ_TIMEOUT_MS = 12_000;
const CLI_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

type DailyReviewDeclaration = (typeof DAILY_REVIEW_DECLARATIONS)[keyof typeof DAILY_REVIEW_DECLARATIONS];

type NativeJob = {
  id: string;
  declarationKey?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  agentId?: string;
  createdAtMs?: number;
  schedule?: {
    kind?: string;
    expr?: string;
    tz?: string;
    staggerMs?: number;
  };
  sessionTarget?: string;
  payload?: {
    kind?: string;
    argv?: string[];
    timeoutSeconds?: number;
    toolsAllow?: string[];
  };
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
    bestEffort?: boolean;
  };
  state?: {
    runningAtMs?: number;
  };
};

type NativeRunPage = {
  entries?: unknown[];
  total?: number;
  offset?: number;
  limit?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
};

type SchedulerReader = (args: string[]) => Promise<unknown>;

type DailyReviewCommandDeps = {
  readScheduler?: SchedulerReader;
  loadSnapshot?: (boundaryIso: string) => unknown | Promise<unknown>;
  runSemanticModel?: (prompt: string, jobId: string) => Promise<string>;
};

type DailyReviewCommandOptions = {
  declarationKey: string;
  openclawBin: string;
};

function expectedDeclaration(declarationKey: string | undefined) {
  if (declarationKey === DAILY_REVIEW_DECLARATIONS.morning) {
    return {
      declaration: DAILY_REVIEW_DECLARATIONS.morning,
      peer: DAILY_REVIEW_DECLARATIONS.evening,
      name: "tasks-daily-review-morning",
      description: "Task Agent Scheduled Daily Review — 09:30 Europe/Moscow",
      expr: "30 9 * * *",
    } as const;
  }
  if (declarationKey === DAILY_REVIEW_DECLARATIONS.evening) {
    return {
      declaration: DAILY_REVIEW_DECLARATIONS.evening,
      peer: DAILY_REVIEW_DECLARATIONS.morning,
      name: "tasks-daily-review-evening",
      description: "Task Agent Scheduled Daily Review — 17:00 Europe/Moscow",
      expr: "0 17 * * *",
    } as const;
  }
  throw new Error(`Unexpected Daily Review declarationKey: ${String(declarationKey)}`);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeJobs(value: unknown): NativeJob[] {
  if (Array.isArray(value)) return value as NativeJob[];
  const record = assertRecord(value, "Automation list result");
  if (!Array.isArray(record.jobs)) {
    throw new Error("Automation list result has no jobs array");
  }
  return record.jobs as NativeJob[];
}

function expectedCommandArgv(openclawBin: string, declarationKey: DailyReviewDeclaration): string[] {
  return [
    openclawBin,
    DAILY_REVIEW_CLI_COMMAND,
    "daily-review",
    "--declaration-key",
    declarationKey,
    "--openclaw-bin",
    openclawBin,
  ];
}

function sameRoute(left: NativeJob["delivery"], right: NativeJob["delivery"]): boolean {
  return Boolean(
    left &&
      right &&
      left.mode === right.mode &&
      left.channel === right.channel &&
      left.to === right.to &&
      left.accountId === right.accountId &&
      left.threadId === right.threadId &&
      left.bestEffort === right.bestEffort,
  );
}

function validateNativeJob(job: NativeJob, openclawBin: string, label: string) {
  const expected = expectedDeclaration(job.declarationKey);
  if (!job.id || job.enabled !== true) {
    throw new Error(`${label} Daily Review job must be enabled with a stable id`);
  }
  if (job.name !== expected.name || job.description !== expected.description) {
    throw new Error(`${label} Daily Review job metadata drift detected`);
  }
  if (job.agentId !== DAILY_REVIEW_AGENT_ID || job.sessionTarget !== "isolated") {
    throw new Error(`${label} Daily Review job must run as isolated tasks agent`);
  }
  if (
    job.schedule?.kind !== "cron" ||
    job.schedule.expr !== expected.expr ||
    job.schedule.tz !== DAILY_REVIEW_TIMEZONE ||
    (job.schedule.staggerMs ?? 0) !== 0
  ) {
    throw new Error(`${label} Daily Review schedule drift detected`);
  }
  if (
    job.payload?.kind !== "command" ||
    JSON.stringify(job.payload.argv) !== JSON.stringify(expectedCommandArgv(openclawBin, expected.declaration)) ||
    job.payload.timeoutSeconds !== COMMAND_TIMEOUT_SECONDS ||
    (job.payload.toolsAllow !== undefined && job.payload.toolsAllow.length !== 0)
  ) {
    throw new Error(`${label} Daily Review command payload drift detected`);
  }
  if (
    job.delivery?.mode !== "announce" ||
    job.delivery.channel !== "telegram" ||
    job.delivery.accountId !== DAILY_REVIEW_AGENT_ID ||
    !job.delivery.to ||
    job.delivery.bestEffort !== false
  ) {
    throw new Error(`${label} Daily Review delivery must be required Telegram announce delivery`);
  }
  if (typeof job.createdAtMs !== "number" || !Number.isFinite(job.createdAtMs) || job.createdAtMs <= 0) {
    throw new Error(`${label} Daily Review job has invalid createdAtMs`);
  }
  return expected;
}

function validatePair(jobs: NativeJob[], currentDeclaration: DailyReviewDeclaration, openclawBin: string) {
  const declared = jobs.filter(
    (job) =>
      job.declarationKey === DAILY_REVIEW_DECLARATIONS.morning ||
      job.declarationKey === DAILY_REVIEW_DECLARATIONS.evening,
  );
  if (declared.length !== 2) {
    throw new Error(`Daily Review requires exactly two declared schedule entries; found ${declared.length}`);
  }
  const current = declared.find((job) => job.declarationKey === currentDeclaration);
  const currentExpected = expectedDeclaration(currentDeclaration);
  const peer = declared.find((job) => job.declarationKey === currentExpected.peer);
  if (!current || !peer) {
    throw new Error("Daily Review current/peer schedule identity mismatch");
  }
  const validatedCurrent = validateNativeJob(current, openclawBin, "current");
  const validatedPeer = validateNativeJob(peer, openclawBin, "peer");
  if (validatedCurrent.peer !== validatedPeer.declaration || !sameRoute(current.delivery, peer.delivery)) {
    throw new Error("Daily Review jobs do not form the expected schedule/delivery pair");
  }
  return { current, peer };
}

function nativeJobFromGet(value: unknown): NativeJob {
  return assertRecord(value, "Automation get result") as NativeJob;
}

function createSchedulerReader(openclawBin: string): SchedulerReader {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        openclawBin,
        args,
        {
          encoding: "utf8",
          timeout: CLI_READ_TIMEOUT_MS,
          maxBuffer: CLI_MAX_BUFFER_BYTES,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `Daily Review scheduler read failed (${args.join(" ")}): ${stderr.trim() || error.message}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (parseError) {
            reject(
              new Error(
                `Daily Review scheduler read returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
              ),
            );
          }
        },
      );
    });
}

function projectForDailyReview(job: NativeJob, bootstrapIso: string, peerJobId: string) {
  return {
    ...job,
    payload: {
      kind: "script",
      script: buildDailyReviewScript({
        group_id: DAILY_REVIEW_GROUP_ID,
        bootstrap_checkpoint: bootstrapIso,
        peer_job_id: peerJobId,
      }),
      toolsAllow: [TASK_DAILY_REVIEW_TOOL],
    },
  };
}

async function buildRuntimeProjection(
  declarationKey: DailyReviewDeclaration,
  openclawBin: string,
  readScheduler: SchedulerReader,
) {
  const listed = normalizeJobs(await readScheduler(["automations", "list", "--all", "--json"]));
  const listedPair = validatePair(listed, declarationKey, openclawBin);
  const [current, peer] = await Promise.all([
    readScheduler(["automations", "get", listedPair.current.id, "--json"]).then(nativeJobFromGet),
    readScheduler(["automations", "get", listedPair.peer.id, "--json"]).then(nativeJobFromGet),
  ]);
  const { current: validatedCurrent, peer: validatedPeer } = validatePair(
    [current, peer],
    declarationKey,
    openclawBin,
  );
  const boundaryMs = validatedCurrent.state?.runningAtMs;
  if (typeof boundaryMs !== "number" || !Number.isFinite(boundaryMs)) {
    throw new Error("Daily Review current native run has no runningAtMs snapshot boundary");
  }
  const bootstrapMs = Math.min(validatedCurrent.createdAtMs!, validatedPeer.createdAtMs!);
  if (!Number.isFinite(bootstrapMs) || bootstrapMs >= boundaryMs) {
    throw new Error("Daily Review native activation boundary is invalid for the current run");
  }
  const bootstrapIso = new Date(bootstrapMs).toISOString();
  const projected = new Map([
    [validatedCurrent.id, projectForDailyReview(validatedCurrent, bootstrapIso, validatedPeer.id)],
    [validatedPeer.id, projectForDailyReview(validatedPeer, bootstrapIso, validatedCurrent.id)],
  ]);
  const params = {
    group_id: DAILY_REVIEW_GROUP_ID,
    bootstrap_checkpoint: bootstrapIso,
    peer_job_id: validatedPeer.id,
  } as const;
  return {
    current: validatedCurrent,
    peer: validatedPeer,
    params,
    readGateway: async (method: "cron.get" | "cron.runs", request: Record<string, unknown>) => {
      const id = typeof request.id === "string" ? request.id : "";
      if (!projected.has(id)) {
        throw new Error(`Daily Review requested scheduler data outside the validated pair: ${id}`);
      }
      if (method === "cron.get") return projected.get(id);
      const limit = Number.isSafeInteger(request.limit) && Number(request.limit) > 0 ? Number(request.limit) : 200;
      const offset = Number.isSafeInteger(request.offset) && Number(request.offset) >= 0 ? Number(request.offset) : 0;
      const sort = request.sortDir === "asc" ? "asc" : "desc";
      const raw = (await readScheduler([
        "automations",
        "runs",
        id,
        "--json",
        "--limit",
        String(limit),
        "--offset",
        String(offset),
        "--sort",
        sort,
      ])) as NativeRunPage;
      if (!raw || !Array.isArray(raw.entries)) {
        throw new Error(`Daily Review native history for ${id} has no entries array`);
      }
      return raw;
    },
  };
}

function parseDeclarationKey(value: string): DailyReviewDeclaration {
  if (value === DAILY_REVIEW_DECLARATIONS.morning || value === DAILY_REVIEW_DECLARATIONS.evening) {
    return value;
  }
  throw new Error(`Unsupported Daily Review declaration: ${value}`);
}

export async function executeDailyReviewCommand(
  api: OpenClawPluginApi,
  options: DailyReviewCommandOptions,
  deps: DailyReviewCommandDeps = {},
) {
  const declarationKey = parseDeclarationKey(options.declarationKey);
  if (!options.openclawBin.startsWith("/") || options.openclawBin.includes("\u0000")) {
    throw new Error("Daily Review openclaw binary must be an absolute path");
  }
  const readScheduler = deps.readScheduler ?? createSchedulerReader(options.openclawBin);
  const runtime = await buildRuntimeProjection(declarationKey, options.openclawBin, readScheduler);
  const toolContext = {
    agentId: DAILY_REVIEW_AGENT_ID,
    sessionKey: `agent:tasks:cron:${runtime.current.id}:trigger`,
    config: api.config,
  } as unknown as OpenClawPluginToolContext;
  return executeDailyReview(runtime.params, {
    api,
    toolContext,
    readGateway: runtime.readGateway,
    ...(deps.loadSnapshot ? { loadSnapshot: deps.loadSnapshot as never } : {}),
    ...(deps.runSemanticModel ? { runSemanticModel: deps.runSemanticModel } : {}),
  });
}

export function registerDailyReviewCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const root = program
        .command(DAILY_REVIEW_CLI_COMMAND)
        .description("Internal Task Agent runtime commands");
      root
        .command("daily-review")
        .description("Run one scheduler-owned Task Daily Review")
        .requiredOption("--declaration-key <key>")
        .requiredOption("--openclaw-bin <path>")
        .action(async (options: DailyReviewCommandOptions) => {
          const result = await executeDailyReviewCommand(api, options);
          if (!result.suppress && result.message) {
            process.stdout.write(`${result.message}\n`);
          }
        });
    },
    {
      descriptors: [
        {
          name: DAILY_REVIEW_CLI_COMMAND,
          description: "Internal Task Agent runtime commands",
          hasSubcommands: true,
        },
      ],
    },
  );
}

export const dailyReviewRuntimeInternals = {
  expectedDeclaration,
  expectedCommandArgv,
  validateNativeJob,
  validatePair,
  buildRuntimeProjection,
  parseDeclarationKey,
};
