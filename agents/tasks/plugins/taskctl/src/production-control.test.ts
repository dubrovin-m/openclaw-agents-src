import { describe, expect, it, vi } from "vitest";
import {
  TASK_PRODUCTION_CONTROL_TOOL,
  executeProductionControl,
  productionControlApproval,
  validateProductionControlParams,
} from "./production-control.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("Task production-control semantic tool", () => {
  it("accepts only the three registered typed operations", () => {
    expect(validateProductionControlParams({ action: "status" })).toMatchObject({ ok: true });
    expect(validateProductionControlParams({ action: "diagnose" })).toMatchObject({ ok: true });
    expect(validateProductionControlParams({ action: "deploy", sha: SHA })).toMatchObject({ ok: true });
    expect(validateProductionControlParams({ action: "deploy", sha: "main" })).toMatchObject({ ok: false });
    expect(validateProductionControlParams({ action: "status", sha: SHA })).toMatchObject({ ok: false });
    expect(validateProductionControlParams({ action: "shell", command: "id" })).toMatchObject({ ok: false });
  });

  it("dispatches directly to controller semantic operations without shell execution", async () => {
    const status = vi.fn(async () => ({ ok: true, mode: "ACTIVE" }));
    const diagnose = vi.fn(async () => ({ ok: true, checks: {} }));
    const deploy = vi.fn(async (sha: string) => ({ ok: true, accepted: true, sha }));
    const loadController = async () => ({ getSemanticStatus: status, runSemanticDiagnostics: diagnose, requestSemanticDeployment: deploy });

    await expect(executeProductionControl({ action: "status" }, { loadController })).resolves.toEqual({ ok: true, mode: "ACTIVE" });
    await expect(executeProductionControl({ action: "diagnose" }, { loadController })).resolves.toEqual({ ok: true, checks: {} });
    await expect(executeProductionControl({ action: "deploy", sha: SHA }, { loadController })).resolves.toEqual({ ok: true, accepted: true, sha: SHA });
    expect(status).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(deploy).toHaveBeenCalledWith(SHA);
  });

  it("fails closed before loading the controller for malformed parameters", async () => {
    const loadController = vi.fn(async () => { throw new Error("must not load"); });
    const result = await executeProductionControl({ action: "deploy", sha: "main" }, { loadController });
    expect(result).toMatchObject({ ok: false, error: { code: "TASK_PRODUCTION_CONTROL_VALIDATION_ERROR" } });
    expect(loadController).not.toHaveBeenCalled();
  });

  it("requires one non-persistent critical approval for deploy only", () => {
    expect(productionControlApproval({ toolName: TASK_PRODUCTION_CONTROL_TOOL, params: { action: "status" } }, { agentId: "main" })).toBeUndefined();
    expect(productionControlApproval({ toolName: TASK_PRODUCTION_CONTROL_TOOL, params: { action: "diagnose" } }, { agentId: "main" })).toBeUndefined();
    expect(productionControlApproval({ toolName: TASK_PRODUCTION_CONTROL_TOOL, params: { action: "deploy", sha: SHA } }, { agentId: "main" })).toMatchObject({
      requireApproval: {
        title: "Deploy Task Agent",
        severity: "critical",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
  });

  it("blocks production control when invoked by any agent other than main", () => {
    expect(productionControlApproval({ toolName: TASK_PRODUCTION_CONTROL_TOOL, params: { action: "status" } }, { agentId: "tasks" })).toEqual({
      block: true,
      blockReason: "Task production control is restricted to the main agent.",
    });
  });
});
