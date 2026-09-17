import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { normalizeOpenAIToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { ACTION_REGISTRY, TASKCTL_ACTIONS, actionPayloadSchema, actionToolParameters, getActionDefinition } from "./contract.js";
import { TASK_DAILY_REVIEW_TOOL } from "./daily-review.js";
import { executeTaskctl } from "./index.js";
import { TASK_MANAGEMENT_REVIEW_TOOL } from "./management-review.js";
import { TASK_REMINDER_DISPATCH_TOOL } from "./reminder-runtime.js";
import { TASK_PRODUCTION_CONTROL_TOOL } from "./production-control.js";
import entry from "./plugin.js";

const schemaProperties = (schema: unknown) => (schema as { properties?: Record<string, unknown> }).properties ?? {};
const schemaRequired = (schema: unknown) => (schema as { required?: string[] }).required ?? [];
const metadataTools = () => getToolPluginMetadata(entry)?.tools ?? [];
const ordinaryToolNames = () => [...TASKCTL_ACTIONS, TASK_PRODUCTION_CONTROL_TOOL];
const schedulerToolNames = () => [TASK_DAILY_REVIEW_TOOL, TASK_MANAGEMENT_REVIEW_TOOL, TASK_REMINDER_DISPATCH_TOOL];
const allToolNames = () => [...ordinaryToolNames(), ...schedulerToolNames()];
const labelAssociationFields = ["label_id", "operation_key", "task_id"];
const projectAssociationFields = ["operation_key", "project_id", "task_id"];

describe("Task Agent model-visible per-action tool contracts", () => {
  it("registers all deterministic task actions plus production control and the scheduler-only Daily Review factory", () => {
    const names = metadataTools().map((tool) => tool.name);
    expect(TASKCTL_ACTIONS).toHaveLength(59);
    expect(names).toEqual(allToolNames());
    expect(names).not.toContain("taskctl");
    expect(new Set(names).size).toBe(63);
    expect(ordinaryToolNames()).toHaveLength(60);
  });

  it("keeps the static OpenClaw manifest aligned with the tool registry", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
      contracts?: { tools?: string[] };
    };
    expect(manifest.contracts?.tools).toEqual(allToolNames());
  });

  it("keeps scheduler-only tools out of the ordinary model-visible normalization surface", () => {
    const tools = metadataTools().filter((tool) => !schedulerToolNames().includes(tool.name));
    const normalized = normalizeOpenAIToolSchemas({
      tools,
      provider: "openai",
      modelApi: "openai-responses",
      model: {
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.6-luna",
      },
    } as never);
    expect(normalized.map((tool) => tool.name)).toEqual(ordinaryToolNames());
  });

  it("generates every Task Agent root schema uniformly from the single action registry", () => {
    for (const action of TASKCTL_ACTIONS) {
      const definition = getActionDefinition(action);
      const schema = actionPayloadSchema(action);
      expect(Object.keys(schemaProperties(schema)).sort(), action).toEqual([...definition.allowed].sort());
      expect([...schemaRequired(schema)].sort(), action).toEqual([...(definition.required ?? [])].sort());
      expect((schema as { additionalProperties?: boolean }).additionalProperties, action).toBe(false);
      expect((schema as { allOf?: unknown[] }).allOf?.length ?? 0, action).toBe(definition.exactlyOneOf?.length ?? 0);
    }
  });

  it("keeps action descriptions semantic rather than mechanical fallbacks", () => {
    for (const action of TASKCTL_ACTIONS) {
      const definition = getActionDefinition(action);
      expect(definition.description.trim().length, action).toBeGreaterThan(20);
      expect(definition.description, action).not.toContain("Perform the bounded Task Agent");
      expect(definition.label.trim().length, action).toBeGreaterThan(0);
    }
  });

  it("binds representative schemas to their deterministic entity and field contracts", () => {
    expect(Object.keys(schemaProperties(actionPayloadSchema("task_get")))).toEqual(["id"]);
    expect(schemaRequired(actionPayloadSchema("task_get"))).toEqual(["id"]);
    expect(Value.Check(actionToolParameters("task_get"), { id: "T-1" })).toBe(true);
    expect(Value.Check(actionToolParameters("task_get"), { id: "I-1" })).toBe(false);

    expect(Object.keys(schemaProperties(actionPayloadSchema("project_get")))).toEqual(["id"]);
    expect(schemaRequired(actionPayloadSchema("project_get"))).toEqual(["id"]);
    expect(Value.Check(actionToolParameters("project_get"), { id: "PRJ-1" })).toBe(true);
    expect(Value.Check(actionToolParameters("project_get"), { id: 1 })).toBe(false);
    expect(Value.Check(actionToolParameters("project_get"), { id: "1" })).toBe(false);
    expect(Value.Check(actionToolParameters("project_get"), { id: "P-1" })).toBe(false);

    expect(Object.keys(schemaProperties(actionPayloadSchema("inbox_add"))).sort()).toEqual(["capture_key", "content", "operation_key"]);
    expect([...schemaRequired(actionPayloadSchema("inbox_add"))].sort()).toEqual(["capture_key", "content", "operation_key"]);
    expect(Value.Check(actionToolParameters("inbox_add"), { operation_key: "capture", capture_key: "telegram-1", content: "Test" })).toBe(true);
    expect(Value.Check(actionToolParameters("inbox_add"), { content: "Test" })).toBe(false);

    expect(Object.keys(schemaProperties(actionPayloadSchema("ref_resolve"))).sort()).toEqual(["context", "number"]);
    expect(schemaRequired(actionPayloadSchema("ref_resolve"))).toEqual(["number"]);

    const reminderCreate = actionToolParameters("reminder_create");
    expect(Object.keys(schemaProperties(reminderCreate)).sort()).toEqual(["operation_key", "task_id", "text", "trigger_date", "trigger_time"]);
    expect([...schemaRequired(reminderCreate)].sort()).toEqual(["operation_key", "trigger_date", "trigger_time"]);
    expect(Value.Check(reminderCreate, { operation_key: "r", task_id: "T-1", trigger_date: "2026-09-18", trigger_time: "12:00" })).toBe(true);
    expect(Value.Check(reminderCreate, { operation_key: "r", text: "Позвонить маме", trigger_date: "2026-09-18", trigger_time: "18:00" })).toBe(true);
    expect(Value.Check(reminderCreate, { operation_key: "r", task_id: "T-1", text: "bad", trigger_date: "2026-09-18", trigger_time: "12:00" })).toBe(false);
    expect(Value.Check(actionToolParameters("reminder_reschedule"), { operation_key: "r2", id: "REM-1", trigger_date: "2026-09-19", trigger_time: "09:00" })).toBe(true);
    expect(Value.Check(actionToolParameters("reminder_cancel"), { operation_key: "r3", id: "REM-1" })).toBe(true);
    expect(Value.Check(actionToolParameters("reminder_cancel"), { operation_key: "r3", id: "R-1" })).toBe(false);
  });

  it("TA-PRJ-036..038 keeps Project schemas minimal and canonical-ID-only", () => {
    const taskProject = actionToolParameters("task_project_set");
    expect(Object.keys(schemaProperties(taskProject)).sort()).toEqual(projectAssociationFields);
    expect([...schemaRequired(taskProject)].sort()).toEqual(projectAssociationFields);
    expect(Value.Check(taskProject, { operation_key: "project", task_id: "T-1", project_id: "PRJ-1" })).toBe(true);
    expect(Value.Check(taskProject, { operation_key: "project", task_id: "T-1", project_id: 1 })).toBe(false);
    expect(Value.Check(taskProject, { operation_key: "project", task_id: "T-1", project_id: "1" })).toBe(false);
    expect(Value.Check(taskProject, { operation_key: "project", task_id: "T-1", project_id: null })).toBe(true);
    expect(Value.Check(taskProject, { operation_key: "project", task_id: "T-1", project_id: "P-1" })).toBe(false);
    expect(Value.Check(taskProject, { operation_key: "project", task_id: "T-1", project: "X" })).toBe(false);

    const taskCreate = actionToolParameters("task_create");
    expect(Value.Check(taskCreate, { operation_key: "create", title: "Test", assignee: "Дубровин М.", project_id: "PRJ-1" })).toBe(true);
    expect(Value.Check(taskCreate, { operation_key: "create", title: "Test", assignee: "Дубровин М.", project_id: null })).toBe(false);
    expect(Value.Check(taskCreate, { operation_key: "create", title: "Test", assignee: "Дубровин М.", project: "X" })).toBe(false);

    const projectList = actionToolParameters("project_list");
    expect(Value.Check(projectList, {})).toBe(true);
    expect(Value.Check(projectList, { status: "ACTIVE", search: "ИИ", limit: 20 })).toBe(true);
    expect(Value.Check(projectList, { status: "OPEN" })).toBe(false);
  });

  it("keeps task_create on one required model-visible assignee field while keeping Task Label associations canonical-id-only", () => {
    const taskCreate = actionToolParameters("task_create");
    expect(Object.keys(schemaProperties(taskCreate)).sort()).toEqual(["assignee", "create_assignee", "due_date", "due_time", "labels", "operation_key", "project_id", "status", "title"]);
    expect([...schemaRequired(taskCreate)].sort()).toEqual(["assignee", "operation_key", "title"]);
    expect((taskCreate as { allOf?: unknown[] }).allOf).toBeUndefined();
    expect(Value.Check(taskCreate, { operation_key: "create", title: "Test" })).toBe(false);
    expect(Value.Check(taskCreate, { operation_key: "create", title: "Test", assignee: "Дубровин М." })).toBe(true);
    expect(Value.Check(taskCreate, { operation_key: "create", title: "Взять входной на 7.10", assignee: "P-1", due_date: "2026-09-16" })).toBe(true);
    expect(Value.Check(taskCreate, { operation_key: "create", title: "Test", assignee_id: "P-1" })).toBe(false);

    const inboxCommit = actionToolParameters("inbox_commit");
    const inboxTask = (schemaProperties(inboxCommit).tasks as { items?: unknown }).items;
    expect(Object.keys(schemaProperties(inboxTask)).sort()).toEqual(["assignee", "create_assignee", "due_date", "due_time", "labels", "project_id", "status", "title"]);
    expect([...schemaRequired(inboxTask)].sort()).toEqual(["assignee", "title"]);
    expect(Value.Check(inboxCommit, { operation_key: "commit", id: "I-1", tasks: [{ title: "Взять входной на 7.10", assignee: "P-1" }] })).toBe(true);
    expect(Value.Check(inboxCommit, { operation_key: "commit", id: "I-1", tasks: [{ title: "Взять входной на 7.10", assignee_id: "P-1" }] })).toBe(false);

    for (const action of ["task_label_add", "task_label_remove"] as const) {
      const parameters = actionToolParameters(action);
      expect(Object.keys(schemaProperties(parameters)).sort()).toEqual(labelAssociationFields);
      expect([...schemaRequired(parameters)].sort()).toEqual(labelAssociationFields);
      expect(Value.Check(parameters, { operation_key: "label", task_id: "T-1", label_id: "L-1" })).toBe(true);
      expect(Value.Check(parameters, { operation_key: "label", task_id: "T-1", label: "Board" })).toBe(false);
      expect(Value.Check(parameters, { operation_key: "label", task_id: "T-1", label_id: "L-1", create_label: true })).toBe(false);
    }
  });

  it("TA-REC-035 and TA-REM-020 keep all 60 ordinary contracts through pinned OpenAI Responses normalization", () => {
    const tools = metadataTools().filter((tool) => !schedulerToolNames().includes(tool.name));
    const normalized = normalizeOpenAIToolSchemas({
      tools,
      provider: "openai",
      modelApi: "openai-responses",
      model: {
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.6-luna",
      },
    } as never);
    expect(normalized).toHaveLength(60);
    const byName = new Map(normalized.map((tool) => [tool.name, tool.parameters]));
    for (const action of TASKCTL_ACTIONS) {
      const normalizedSchema = byName.get(action);
      expect(normalizedSchema, action).toBeDefined();
      expect(Object.keys(schemaProperties(normalizedSchema)).sort(), action).toEqual([...getActionDefinition(action).allowed].sort());
      expect([...schemaRequired(normalizedSchema)].sort(), action).toEqual([...(getActionDefinition(action).required ?? [])].sort());
    }
    const normalizedTaskCreate = byName.get("task_create");
    expect((normalizedTaskCreate as { allOf?: unknown[] }).allOf).toBeUndefined();
    expect(Object.keys(schemaProperties(normalizedTaskCreate)).sort()).toEqual(["assignee", "create_assignee", "due_date", "due_time", "labels", "operation_key", "project_id", "status", "title"]);
    expect([...schemaRequired(normalizedTaskCreate)].sort()).toEqual(["assignee", "operation_key", "title"]);
    expect(Value.Check(normalizedTaskCreate as never, { operation_key: "create", title: "Взять входной на 7.10", assignee: "P-1", due_date: "2026-09-16" })).toBe(true);
    expect(Value.Check(normalizedTaskCreate as never, { operation_key: "create", title: "Взять входной на 7.10", assignee_id: "P-1", due_date: "2026-09-16" })).toBe(false);
    const normalizedInboxCommit = byName.get("inbox_commit");
    const normalizedInboxTask = (schemaProperties(normalizedInboxCommit).tasks as { items?: unknown }).items;
    expect(Object.keys(schemaProperties(normalizedInboxTask)).sort()).toEqual(["assignee", "create_assignee", "due_date", "due_time", "labels", "project_id", "status", "title"]);
    expect([...schemaRequired(normalizedInboxTask)].sort()).toEqual(["assignee", "title"]);
    expect(Value.Check(normalizedInboxCommit as never, { operation_key: "commit", id: "I-1", tasks: [{ title: "Взять входной на 7.10", assignee: "P-1" }] })).toBe(true);
    expect(Value.Check(normalizedInboxCommit as never, { operation_key: "commit", id: "I-1", tasks: [{ title: "Взять входной на 7.10", assignee_id: "P-1" }] })).toBe(false);
    for (const action of ["task_label_add", "task_label_remove"] as const) {
      const normalizedSchema = byName.get(action);
      expect(Object.keys(schemaProperties(normalizedSchema)).sort()).toEqual(labelAssociationFields);
      expect([...schemaRequired(normalizedSchema)].sort()).toEqual(labelAssociationFields);
      expect(Value.Check(normalizedSchema as never, { operation_key: "label", task_id: "T-1", label_id: "L-1" })).toBe(true);
      expect(Value.Check(normalizedSchema as never, { operation_key: "label", task_id: "T-1", label: "Board" })).toBe(false);
    }
    const normalizedProject = byName.get("task_project_set");
    expect(Object.keys(schemaProperties(normalizedProject)).sort()).toEqual(projectAssociationFields);
    expect([...schemaRequired(normalizedProject)].sort()).toEqual(projectAssociationFields);
    expect(Value.Check(normalizedProject as never, { operation_key: "project", task_id: "T-1", project_id: "PRJ-1" })).toBe(true);
    expect(Value.Check(normalizedProject as never, { operation_key: "project", task_id: "T-1", project_id: null })).toBe(true);
    expect(Value.Check(normalizedProject as never, { operation_key: "project", task_id: "T-1", project_id: "L-1" })).toBe(false);

    const productionControl = byName.get(TASK_PRODUCTION_CONTROL_TOOL);
    expect(productionControl).toBeDefined();
    expect(Object.keys(schemaProperties(productionControl)).sort()).toEqual(["action", "sha"]);
    expect(schemaRequired(productionControl)).toEqual(["action"]);
    expect(byName.has(TASK_DAILY_REVIEW_TOOL)).toBe(false);
    expect(byName.has(TASK_MANAGEMENT_REVIEW_TOOL)).toBe(false);
    expect(byName.has(TASK_REMINDER_DISPATCH_TOOL)).toBe(false);
  });

  it("keeps task_update free of status and Project association", () => {
    expect(schemaProperties(actionPayloadSchema("task_update"))).not.toHaveProperty("status");
    expect(schemaProperties(actionPayloadSchema("task_update"))).not.toHaveProperty("project_id");
    expect(Object.keys(schemaProperties(actionPayloadSchema("task_complete"))).sort()).toEqual(["id", "operation_key"]);
    expect(Object.keys(schemaProperties(actionPayloadSchema("task_cancel"))).sort()).toEqual(["id", "operation_key"]);
    expect(ACTION_REGISTRY.task_complete.argv).toEqual(["task", "complete"]);
    expect(ACTION_REGISTRY.task_cancel.argv).toEqual(["task", "cancel"]);
  });

  it("keeps the deterministic validator fail-closed before backend spawn", async () => {
    let spawned = false;
    const result = await executeTaskctl(
      "project_get",
      { id: "T-1" },
      { spawnImpl: (() => { spawned = true; throw new Error("must not spawn"); }) as never },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "TASKCTL_VALIDATION_ERROR" } });
    expect(spawned).toBe(false);
  });

  it("rejects task_update Project/status fields before backend spawn", async () => {
    let spawned = false;
    const result = await executeTaskctl(
      "task_update",
      { operation_key: "update-project", id: "T-1", project_id: "PRJ-1" },
      { spawnImpl: (() => { spawned = true; throw new Error("must not spawn"); }) as never },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "TASKCTL_VALIDATION_ERROR" } });
    expect(spawned).toBe(false);
  });
});
