import { Type, type Static } from "typebox";
export declare const TASK_PRODUCTION_CONTROL_TOOL = "task_production_control";
export declare const TASK_PRODUCTION_CONTROL_MODULE = "/home/dubrovin/.local/lib/openclaw-production-control/controller.mjs";
export declare const productionControlParameters: Type.TObject<{
    action: Type.TUnion<[Type.TLiteral<"status">, Type.TLiteral<"diagnose">, Type.TLiteral<"deploy">]>;
    sha: Type.TOptional<Type.TString>;
}>;
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
declare const structuredError: (code: string, message: string) => {
    ok: boolean;
    error: {
        code: string;
        message: string;
    };
};
export declare function validateProductionControlParams(params: unknown): {
    ok: true;
    params: ProductionControlParams;
} | {
    ok: false;
    error: ReturnType<typeof structuredError>;
};
export declare function executeProductionControl(params: unknown, options?: ExecuteOptions): Promise<unknown>;
export declare function productionControlApproval(event: {
    toolName?: string;
    params?: Record<string, unknown>;
}, context: {
    agentId?: string;
}): {
    block: boolean;
    blockReason: string;
    requireApproval?: undefined;
} | {
    requireApproval: {
        title: string;
        description: string;
        severity: "critical";
        allowedDecisions: ("allow-once" | "deny")[];
        timeoutMs: number;
    };
    block?: undefined;
    blockReason?: undefined;
} | undefined;
export {};
