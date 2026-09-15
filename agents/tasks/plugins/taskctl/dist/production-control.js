import { pathToFileURL } from "node:url";
import { Type } from "typebox";
export const TASK_PRODUCTION_CONTROL_TOOL = "task_production_control";
export const TASK_PRODUCTION_CONTROL_MODULE = "/home/dubrovin/.local/lib/openclaw-production-control/controller.mjs";
export const productionControlParameters = Type.Object({
    action: Type.Union([Type.Literal("status"), Type.Literal("diagnose"), Type.Literal("deploy")]),
    sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}$" })),
}, { additionalProperties: false });
const structuredError = (code, message) => ({ ok: false, error: { code, message } });
export function validateProductionControlParams(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, error: structuredError("TASK_PRODUCTION_CONTROL_VALIDATION_ERROR", "parameters must be an object") };
    }
    const value = params;
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
    }
    else if (Object.hasOwn(value, "sha")) {
        return { ok: false, error: structuredError("TASK_PRODUCTION_CONTROL_VALIDATION_ERROR", "sha is allowed only for deploy") };
    }
    return { ok: true, params: value };
}
async function loadInstalledController() {
    const module = await import(`${pathToFileURL(TASK_PRODUCTION_CONTROL_MODULE).href}?semantic=${Date.now()}`);
    if (typeof module.getSemanticStatus !== "function"
        || typeof module.runSemanticDiagnostics !== "function"
        || typeof module.requestSemanticDeployment !== "function") {
        throw new Error("installed production controller does not expose the semantic operation contract");
    }
    return module;
}
export async function executeProductionControl(params, options = {}) {
    const validated = validateProductionControlParams(params);
    if (!validated.ok)
        return validated.error;
    if (options.signal?.aborted)
        return structuredError("TASK_PRODUCTION_CONTROL_ABORTED", "production-control call was aborted");
    let controller;
    try {
        controller = await (options.loadController ?? loadInstalledController)();
    }
    catch (error) {
        return structuredError("TASK_PRODUCTION_CONTROL_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    }
    if (options.signal?.aborted)
        return structuredError("TASK_PRODUCTION_CONTROL_ABORTED", "production-control call was aborted");
    try {
        if (validated.params.action === "status")
            return await controller.getSemanticStatus();
        if (validated.params.action === "diagnose")
            return await controller.runSemanticDiagnostics();
        return await controller.requestSemanticDeployment(validated.params.sha);
    }
    catch (error) {
        return structuredError("TASK_PRODUCTION_CONTROL_ERROR", error instanceof Error ? error.message : String(error));
    }
}
export function productionControlApproval(event, context) {
    if (event.toolName !== TASK_PRODUCTION_CONTROL_TOOL)
        return undefined;
    if (context.agentId !== "main") {
        return { block: true, blockReason: "Task production control is restricted to the main agent." };
    }
    const validated = validateProductionControlParams(event.params ?? {});
    if (!validated.ok) {
        return { block: true, blockReason: validated.error.error.message };
    }
    if (validated.params.action !== "deploy")
        return undefined;
    const sha = validated.params.sha;
    return {
        requireApproval: {
            title: "Deploy Task Agent",
            description: `Deploy Task Agent revision ${sha.slice(0, 12)} after deterministic production-control gates.`,
            severity: "critical",
            allowedDecisions: ["allow-once", "deny"],
            timeoutMs: 300_000,
        },
    };
}
