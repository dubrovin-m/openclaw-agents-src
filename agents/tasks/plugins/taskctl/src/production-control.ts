import { pathToFileURL } from "node:url";
import { Type, type Static } from "typebox";

export const TASK_PRODUCTION_CONTROL_TOOL = "task_production_control";
export const TASK_PRODUCTION_CONTROL_MODULE = "/home/dubrovin/.local/lib/openclaw-production-control/controller.mjs";

export const productionControlParameters = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("diagnose"), Type.Literal("deploy")]),
  sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
}, { additionalProperties: false });

export type ProductionControlParams = Static<typeof productionControlParameters>;

type ProductionController = {
  getSemanticStatus: () => unknown | Promise<unknown>;
  runSemanticDiagnostics: () => unknown | Promise<unknown>;
  requestSemanticDeployment: (sha: string) => unknown | Promise<unknown>;
};

type ControllerLoader = () => Promise<ProductionController>;

type ExecuteOptions = {
  signal?: AbortSignal;
  loadController?: ControllerLoader;
};

const structuredError = (code: string, message: string) => ({ ok: false, error: { code, message } });

export function validateProductionControlParams(params: unknown):
  | { ok: true; params: ProductionControlParams }
  | { ok: false; error: ReturnType<typeof structuredError> } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, error: structuredError("TASK_PRODUCTION_CONTROL_VALIDATION_ERROR", "parameters must be an object") };
  }
  const value = params as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "action" && key !== "sha")) {
    return { ok: false, error: structuredError("TASK_PRODUCTION_CONTROL_VALIDATION_ERROR", "parameters contain unsupported fields") };
  }
  if (value.action !== "status" && value.action !== "diagnose" && value.action !== "deploy") {
    return { ok: false, error: structuredError("TASK_PRODUCTION_CONTROL_VALIDATION_ERROR", "action must be status, diagnose, or deploy") };
  }
  if (value.action === "deploy") {
    if (typeof value.sha !== "string" || !/^[0-9a-f]{40}$/u.test(value.sha)) {
      return { ok: false, error: structuredError("TASK_PRODUCTION_CONTROL_VALIDATION_ERROR", "deploy requires an exact 40-character lowercase SHA") };
    }
  } else if (Object.hasOwn(value, "sha")) {
    return { ok: false, error: structuredError("TASK_PRODUCTION_CONTROL_VALIDATION_ERROR", "sha is allowed only for deploy") };
  }
  return { ok: true, params: value as ProductionControlParams };
}

async function loadInstalledController(): Promise<ProductionController> {
  const module = await import(`${pathToFileURL(TASK_PRODUCTION_CONTROL_MODULE).href}?semantic=${Date.now()}`);
  if (typeof module.getSemanticStatus !== "function"
      || typeof module.runSemanticDiagnostics !== "function"
      || typeof module.requestSemanticDeployment !== "function") {
    throw new Error("installed production controller does not expose the semantic operation contract");
  }
  return module as ProductionController;
}

export async function executeProductionControl(params: unknown, options: ExecuteOptions = {}) {
  const validated = validateProductionControlParams(params);
  if (!validated.ok) return validated.error;
  if (options.signal?.aborted) return structuredError("TASK_PRODUCTION_CONTROL_ABORTED", "production-control call was aborted");

  let controller: ProductionController;
  try {
    controller = await (options.loadController ?? loadInstalledController)();
  } catch (error) {
    return structuredError("TASK_PRODUCTION_CONTROL_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  }

  if (options.signal?.aborted) return structuredError("TASK_PRODUCTION_CONTROL_ABORTED", "production-control call was aborted");
  try {
    if (validated.params.action === "status") return await controller.getSemanticStatus();
    if (validated.params.action === "diagnose") return await controller.runSemanticDiagnostics();
    return await controller.requestSemanticDeployment(validated.params.sha as string);
  } catch (error) {
    return structuredError("TASK_PRODUCTION_CONTROL_ERROR", error instanceof Error ? error.message : String(error));
  }
}

export function productionControlApproval(event: { toolName?: string; params?: Record<string, unknown> }, context: { agentId?: string }) {
  if (event.toolName !== TASK_PRODUCTION_CONTROL_TOOL) return undefined;
  if (context.agentId !== "main") {
    return { block: true, blockReason: "Task production control is restricted to the main agent." };
  }
  const validated = validateProductionControlParams(event.params ?? {});
  if (!validated.ok) {
    return { block: true, blockReason: validated.error.error.message };
  }
  if (validated.params.action !== "deploy") return undefined;
  const sha = validated.params.sha as string;
  return {
    requireApproval: {
      title: "Deploy Task Agent",
      description: `Deploy Task Agent revision ${sha.slice(0, 12)} after deterministic production-control gates.`,
      severity: "critical" as const,
      allowedDecisions: ["allow-once", "deny"] as ("allow-once" | "deny")[],
      timeoutMs: 300_000,
    },
  };
}
