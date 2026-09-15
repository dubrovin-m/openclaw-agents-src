import { Type } from "typebox";
const entityId = (prefix) => Type.Union([
    Type.Integer({ minimum: 1 }),
    Type.String({ pattern: `^(?:${prefix}-)?[1-9]\\d*$` }),
]);
const inboxId = entityId("I");
const taskId = entityId("T");
const personId = entityId("P");
const labelId = entityId("L");
const projectId = Type.String({ pattern: "^PRJ-[1-9]\\d*$" });
const recurrenceId = Type.String({ pattern: "^R-[1-9]\\d*$" });
const canonicalTaskId = Type.String({ pattern: "^T-[1-9]\\d*$" });
const canonicalPersonId = Type.String({ pattern: "^P-[1-9]\\d*$" });
const canonicalLabelId = Type.String({ pattern: "^L-[1-9]\\d*$" });
const nullableProjectId = Type.Union([projectId, Type.Null()]);
const operationKey = Type.String({ minLength: 1, maxLength: 500 });
const dueDate = Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()]);
const dueTime = Type.Union([Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }), Type.Null()]);
const emoji = Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]);
const taskStatus = Type.Union([Type.Literal("OPEN"), Type.Literal("DONE")]);
const filterStatus = Type.Union([Type.Literal("OPEN"), Type.Literal("DONE"), Type.Literal("CANCELLED"), Type.Literal("*")]);
const projectFilterStatus = Type.Union([Type.Literal("ACTIVE"), Type.Literal("DONE"), Type.Literal("CANCELLED"), Type.Literal("*")]);
const recurrenceMode = Type.Union([Type.Literal("CALENDAR"), Type.Literal("AFTER_COMPLETION")]);
const recurrenceFilterStatus = Type.Union([Type.Literal("ACTIVE"), Type.Literal("PAUSED"), Type.Literal("CANCELLED"), Type.Literal("*")]);
const calendarRule = Type.Union([
    Type.Object({ kind: Type.Literal("DAYS"), interval: Type.Integer({ minimum: 1 }), start_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("WEEKS"), interval: Type.Integer({ minimum: 1 }), weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, uniqueItems: true }), start_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("MONTHS"), interval: Type.Integer({ minimum: 1 }), day: Type.Integer({ minimum: 1, maximum: 28 }), start_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("YEARLY"), month: Type.Integer({ minimum: 1, maximum: 12 }), day: Type.Integer({ minimum: 1, maximum: 31 }), start_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }) }, { additionalProperties: false }),
]);
const afterCompletionRule = Type.Object({ interval: Type.Integer({ minimum: 1 }), unit: Type.Union([Type.Literal("DAYS"), Type.Literal("WEEKS"), Type.Literal("MONTHS")]) }, { additionalProperties: false });
const recurrenceRule = Type.Union([calendarRule, afterCompletionRule]);
const view = Type.Union([Type.Literal("today"), Type.Literal("overdue"), Type.Literal("no_due")]);
const labelSpec = Type.Union([
    Type.String({ minLength: 1, maxLength: 500 }),
    Type.Object({
        id: Type.Optional(labelId),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        create: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
]);
const newTask = Type.Object({
    title: Type.String({ minLength: 1, maxLength: 2000 }),
    assignee: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    assignee_id: Type.Optional(personId),
    create_assignee: Type.Optional(Type.Boolean()),
    status: Type.Optional(taskStatus),
    due_date: Type.Optional(dueDate),
    due_time: Type.Optional(dueTime),
    labels: Type.Optional(Type.Array(labelSpec, { maxItems: 20 })),
    project_id: Type.Optional(projectId),
}, { additionalProperties: false });
const FIELD_SCHEMAS = {
    operation_key: operationKey,
    capture_key: Type.String({ minLength: 1, maxLength: 500 }),
    content: Type.String({ minLength: 1, maxLength: 20000 }),
    task_id: taskId,
    tasks: Type.Array(newTask, { minItems: 1, maxItems: 20 }),
    title: Type.String({ minLength: 1, maxLength: 2000 }),
    assignee: Type.String({ minLength: 1, maxLength: 500 }),
    assignee_id: personId,
    create_assignee: Type.Boolean(),
    due_date: dueDate,
    due_time: dueTime,
    view,
    due_on: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    due_until: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    search: Type.String({ minLength: 1, maxLength: 1000 }),
    limit: Type.Integer({ minimum: 1, maximum: 200 }),
    reason: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
    display_name: Type.String({ minLength: 1, maxLength: 500 }),
    reference: Type.String({ minLength: 1, maxLength: 500 }),
    alias: Type.String({ minLength: 1, maxLength: 500 }),
    expansion: Type.String({ minLength: 1, maxLength: 2000 }),
    emoji,
    label: Type.String({ minLength: 1, maxLength: 500 }),
    label_id: labelId,
    create_label: Type.Boolean(),
    labels: Type.Array(labelSpec, { maxItems: 20 }),
    number: Type.Integer({ minimum: 1 }),
    context: Type.Union([Type.Literal("task"), Type.Literal("inbox"), Type.Literal("auto")]),
    mode: recurrenceMode,
    rule: recurrenceRule,
    seed_task_id: canonicalTaskId,
    label_ids: Type.Array(canonicalLabelId, { maxItems: 20, uniqueItems: true }),
    target_project_id: Type.Union([projectId, Type.Null()]),
    first_due_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    cycle_anchor_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
};
export const ACTION_REGISTRY = Object.freeze({
    task_update: {
        argv: ["task", "update"], required: ["operation_key", "id"], allowed: ["operation_key", "id", "title", "assignee", "assignee_id", "create_assignee", "due_date", "due_time", "reason"],
        label: "Task update", description: "Apply a reversible field update to one existing OPEN Task; status transitions and Project association are not accepted.",
    },
    task_complete: {
        argv: ["task", "complete"], required: ["operation_key", "id"], allowed: ["operation_key", "id"],
        label: "Task complete", description: "Complete one existing OPEN Task through the deterministic completion transition.",
    },
    task_cancel: {
        argv: ["task", "cancel"], required: ["operation_key", "id"], allowed: ["operation_key", "id"],
        label: "Task cancel", description: "Cancel one existing OPEN Task; call only after the Task Agent behavioral confirmation requirement is satisfied.",
    },
    inbox_add: {
        argv: ["inbox", "add"], required: ["operation_key", "content", "capture_key"], allowed: ["operation_key", "content", "capture_key"],
        label: "Inbox add", description: "Capture one new Inbox item for later processing without creating a Task or Project.",
    },
    inbox_list: {
        argv: ["inbox", "list"], allowed: ["limit"],
        label: "Inbox list", description: "List unresolved Inbox items, optionally bounded by a result limit.",
    },
    inbox_get: {
        argv: ["inbox", "get"], required: ["id"], allowed: ["id"],
        label: "Inbox get", description: "Read one Inbox item by its stable Inbox identifier.",
    },
    inbox_discard: {
        argv: ["inbox", "discard"], required: ["operation_key", "id"], allowed: ["operation_key", "id"],
        label: "Inbox discard", description: "Discard one Inbox item without creating any Task.",
    },
    inbox_commit: {
        argv: ["inbox", "commit"], required: ["operation_key", "id", "tasks"], allowed: ["operation_key", "id", "tasks"],
        label: "Inbox commit", description: "Atomically create the confirmed Task set, including optional resolved Project associations, and remove that Inbox item.",
    },
    task_create: {
        argv: ["task", "create"], required: ["operation_key", "title"], allowed: ["operation_key", "title", "assignee", "assignee_id", "create_assignee", "status", "due_date", "due_time", "labels", "project_id"], exactlyOneOf: [["assignee", "assignee_id"]],
        label: "Task create", description: "Create one Task with an explicit assignee and optional deadline, initial status, Labels, and an already resolved ACTIVE Project association.",
    },
    task_list: {
        argv: ["task", "list"], allowed: ["status", "assignee", "assignee_id", "label", "view", "due_on", "due_until", "search", "limit"],
        label: "Task list", description: "List Tasks using structured status, assignee, Label, deadline, view, text, and limit filters.",
    },
    task_search: {
        argv: ["task", "search"], required: ["search"], allowed: ["search", "status", "assignee", "assignee_id", "label", "view", "due_on", "due_until", "limit"],
        label: "Task search", description: "Search Tasks by text with optional status, assignee, Label, deadline, view, and limit filters.",
    },
    task_get: {
        argv: ["task", "get"], required: ["id"], allowed: ["id"],
        label: "Task get", description: "Read the compact current record for one Task, including its current Project association when present.",
    },
    task_detail: {
        argv: ["task", "detail"], required: ["id"], allowed: ["id"],
        label: "Task detail", description: "Read the detailed current state and related context for one Task, including its current Project association.",
    },
    task_history: {
        argv: ["task", "history"], required: ["id"], allowed: ["id"],
        label: "Task history", description: "Read the chronological Task mutation history; Project-association history is not recorded in this version.",
    },
    recurrence_create: {
        argv: ["recurrence", "create"], required: ["operation_key", "mode", "rule"], allowed: ["operation_key", "mode", "rule", "seed_task_id", "title", "assignee_id", "label_ids", "target_project_id", "due_time", "first_due_date"],
        label: "Recurrence create", description: "Create one deterministic Recurrence, optionally seeding it from one existing OPEN Task; no scheduler administration is exposed.",
    },
    recurrence_list: {
        argv: ["recurrence", "list"], allowed: ["status", "limit"],
        label: "Recurrence list", description: "List Recurrences; defaults to ACTIVE and supports explicit lifecycle filters.",
    },
    recurrence_get: {
        argv: ["recurrence", "get"], required: ["id"], allowed: ["id"],
        label: "Recurrence get", description: "Read the compact current state of one Recurrence by canonical R-* identifier.",
    },
    recurrence_detail: {
        argv: ["recurrence", "detail"], required: ["id"], allowed: ["id"],
        label: "Recurrence detail", description: "Read one Recurrence with current rule, Task template, occurrence references, and cycle-resolution state.",
    },
    recurrence_history: {
        argv: ["recurrence", "history"], required: ["id"], allowed: ["id"],
        label: "Recurrence history", description: "Read reconstructible Recurrence-scoped lifecycle, rule, template, and cycle history.",
    },
    recurrence_update: {
        argv: ["recurrence", "update"], required: ["operation_key", "id"], allowed: ["operation_key", "id", "title", "assignee_id", "label_ids", "target_project_id", "due_time", "rule", "cycle_anchor_date"],
        label: "Recurrence update", description: "Update future Recurrence rule/template state or explicitly establish a new AFTER_COMPLETION cycle anchor; mode is immutable.",
    },
    recurrence_pause: {
        argv: ["recurrence", "pause"], required: ["operation_key", "id"], allowed: ["operation_key", "id"],
        label: "Recurrence pause", description: "Pause one ACTIVE Recurrence without rewriting generated Tasks.",
    },
    recurrence_resume: {
        argv: ["recurrence", "resume"], required: ["operation_key", "id"], allowed: ["operation_key", "id"],
        label: "Recurrence resume", description: "Resume one PAUSED Recurrence; paused calendar slots are skipped and an AFTER_COMPLETION terminal occurrence starts a new cycle from resume date.",
    },
    recurrence_cancel: {
        argv: ["recurrence", "cancel"], required: ["operation_key", "id"], allowed: ["operation_key", "id"],
        label: "Recurrence cancel", description: "Cancel one Recurrence terminally without changing historical generated Tasks; call only after behavioral confirmation.",
    },
    project_create: {
        argv: ["project", "create"], required: ["operation_key", "title"], allowed: ["operation_key", "title"],
        label: "Project create", description: "Create one lightweight Operational Project with ACTIVE lifecycle state and no implicit Tasks.",
    },
    project_list: {
        argv: ["project", "list"], allowed: ["status", "search", "limit"],
        label: "Project list", description: "List Operational Projects; defaults to ACTIVE and may filter lifecycle or search Project titles.",
    },
    project_get: {
        argv: ["project", "get"], required: ["id"], allowed: ["id"],
        label: "Project get", description: "Read one Operational Project with current associated Tasks and derived Task-state counts.",
    },
    project_rename: {
        argv: ["project", "rename"], required: ["operation_key", "id", "title"], allowed: ["operation_key", "id", "title"],
        label: "Project rename", description: "Rename one existing Operational Project without changing lifecycle or Task associations.",
    },
    project_complete: {
        argv: ["project", "complete"], required: ["operation_key", "id"], allowed: ["operation_key", "id"],
        label: "Project complete", description: "Explicitly transition one ACTIVE Operational Project to DONE without changing associated Tasks.",
    },
    project_cancel: {
        argv: ["project", "cancel"], required: ["operation_key", "id"], allowed: ["operation_key", "id"],
        label: "Project cancel", description: "Explicitly transition one ACTIVE Operational Project to CANCELLED without changing associated Tasks.",
    },
    task_project_set: {
        argv: ["task-project", "set"], required: ["operation_key", "task_id", "project_id"], allowed: ["operation_key", "task_id", "project_id"],
        label: "Task Project set", description: "Atomically set, move, or clear one Task's single Operational Project association; non-null destinations must be existing ACTIVE Projects.",
    },
    person_list: {
        argv: ["person", "list"], allowed: [],
        label: "Person list", description: "List canonical People known to the Task Agent.",
    },
    person_resolve: {
        argv: ["person", "resolve"], required: ["reference"], allowed: ["reference"],
        label: "Person resolve", description: "Resolve a person name or alias reference to canonical Person candidates.",
    },
    person_create: {
        argv: ["person", "create"], required: ["operation_key", "display_name"], allowed: ["operation_key", "display_name"],
        label: "Person create", description: "Create one canonical Person with the supplied display name.",
    },
    person_rename: {
        argv: ["person", "rename"], required: ["operation_key", "id", "display_name"], allowed: ["operation_key", "id", "display_name"],
        label: "Person rename", description: "Change the canonical display name of one existing Person.",
    },
    person_alias_add: {
        argv: ["person", "alias_add"], required: ["operation_key", "id", "alias"], allowed: ["operation_key", "id", "alias"],
        label: "Person alias add", description: "Add one alias that resolves to an existing canonical Person.",
    },
    person_alias_remove: {
        argv: ["person", "alias_remove"], required: ["operation_key", "id", "alias"], allowed: ["operation_key", "id", "alias"],
        label: "Person alias remove", description: "Remove one alias from an existing canonical Person.",
    },
    person_merge: {
        argv: ["person", "merge"], required: ["operation_key", "from_id", "into_id"], allowed: ["operation_key", "from_id", "into_id"],
        label: "Person merge", description: "Merge one duplicate Person into another canonical Person while preserving Task relationships.",
    },
    label_list: {
        argv: ["label", "list"], allowed: [],
        label: "Label list", description: "List canonical Labels known to the Task Agent.",
    },
    label_resolve: {
        argv: ["label", "resolve"], required: ["reference"], allowed: ["reference"],
        label: "Label resolve", description: "Resolve a Label name or alias reference to canonical Label candidates.",
    },
    label_create: {
        argv: ["label", "create"], required: ["operation_key", "display_name"], allowed: ["operation_key", "display_name", "emoji"],
        label: "Label create", description: "Create one canonical Label with an optional presentation emoji.",
    },
    label_rename: {
        argv: ["label", "rename"], required: ["operation_key", "id", "display_name"], allowed: ["operation_key", "id", "display_name"],
        label: "Label rename", description: "Change the canonical display name of one existing Label.",
    },
    label_set_emoji: {
        argv: ["label", "set_emoji"], required: ["operation_key", "id", "emoji"], allowed: ["operation_key", "id", "emoji"],
        label: "Label set emoji", description: "Set, change, or clear the presentation emoji of one canonical Label.",
    },
    label_alias_add: {
        argv: ["label", "alias_add"], required: ["operation_key", "id", "alias"], allowed: ["operation_key", "id", "alias"],
        label: "Label alias add", description: "Add one alias that resolves to an existing canonical Label.",
    },
    label_alias_remove: {
        argv: ["label", "alias_remove"], required: ["operation_key", "id", "alias"], allowed: ["operation_key", "id", "alias"],
        label: "Label alias remove", description: "Remove one alias from an existing canonical Label.",
    },
    label_delete: {
        argv: ["label", "delete"], required: ["operation_key", "id"], allowed: ["operation_key", "id"],
        label: "Label delete", description: "Delete one canonical Label and its Task associations without deleting or rewriting Tasks.",
    },
    label_merge: {
        argv: ["label", "merge"], required: ["operation_key", "from_id", "into_id"], allowed: ["operation_key", "from_id", "into_id"],
        label: "Label merge", description: "Merge one duplicate Label into another canonical Label while preserving Task associations.",
    },
    term_list: {
        argv: ["term", "list"], allowed: [],
        label: "Term list", description: "List explicitly stored Task Agent terminology aliases and expansions.",
    },
    term_resolve: {
        argv: ["term", "resolve"], required: ["alias"], allowed: ["alias"],
        label: "Term resolve", description: "Resolve one stored Task Agent terminology alias to its expansion.",
    },
    term_set: {
        argv: ["term", "set"], required: ["operation_key", "alias", "expansion"], allowed: ["operation_key", "alias", "expansion"],
        label: "Term set", description: "Create or replace one explicitly confirmed Task Agent terminology alias and expansion.",
    },
    term_remove: {
        argv: ["term", "remove"], required: ["operation_key", "alias"], allowed: ["operation_key", "alias"],
        label: "Term remove", description: "Remove one stored Task Agent terminology alias.",
    },
    task_label_add: {
        argv: ["task-label", "add"], required: ["operation_key", "task_id", "label_id"], allowed: ["operation_key", "task_id", "label_id"],
        label: "Task Label add", description: "Attach one already resolved canonical Label to one Task by canonical Label identifier.",
    },
    task_label_remove: {
        argv: ["task-label", "remove"], required: ["operation_key", "task_id", "label_id"], allowed: ["operation_key", "task_id", "label_id"],
        label: "Task Label remove", description: "Detach one already resolved canonical Label from one Task without deleting the canonical Label.",
    },
    comment_add: {
        argv: ["comment", "add"], required: ["operation_key", "task_id", "content"], allowed: ["operation_key", "task_id", "content"],
        label: "Comment add", description: "Append one immutable chronological comment to an existing Task.",
    },
    comment_list: {
        argv: ["comment", "list"], required: ["task_id"], allowed: ["task_id"],
        label: "Comment list", description: "List chronological comments attached to one Task.",
    },
    ref_resolve: {
        argv: ["ref", "resolve"], required: ["number"], allowed: ["number", "context"],
        label: "Reference resolve", description: "Resolve a short numeric reference to a stable Task or Inbox identifier within the requested context.",
    },
});
export const TASKCTL_ACTIONS = Object.freeze(Object.keys(ACTION_REGISTRY));
export function getActionDefinition(action) {
    return ACTION_REGISTRY[action];
}
function idSchemaForAction(action) {
    if (action.startsWith("inbox_"))
        return inboxId;
    if (action.startsWith("task_"))
        return taskId;
    if (action.startsWith("project_"))
        return projectId;
    if (action.startsWith("recurrence_"))
        return recurrenceId;
    if (action.startsWith("person_"))
        return personId;
    if (action.startsWith("label_"))
        return labelId;
    throw new Error(`Action ${action} does not support a root id field`);
}
function fieldSchema(action, field) {
    if (field === "id")
        return idSchemaForAction(action);
    if (field === "from_id" || field === "into_id")
        return action.startsWith("person_") ? personId : labelId;
    if (field === "status") {
        if (action === "task_create")
            return taskStatus;
        if (action === "project_list")
            return projectFilterStatus;
        if (action === "recurrence_list")
            return recurrenceFilterStatus;
        return filterStatus;
    }
    if (field === "project_id")
        return action === "task_project_set" ? nullableProjectId : projectId;
    if (field === "assignee_id" && action.startsWith("recurrence_"))
        return canonicalPersonId;
    const schema = FIELD_SCHEMAS[field];
    if (!schema)
        throw new Error(`Missing model-visible field schema for ${action}.${field}`);
    return schema;
}
export function actionPayloadSchema(action) {
    const definition = getActionDefinition(action);
    const properties = Object.fromEntries(definition.allowed.map((field) => [field, fieldSchema(action, field)]));
    const schema = {
        type: "object",
        properties,
        required: [...(definition.required ?? [])],
        additionalProperties: false,
    };
    if (definition.exactlyOneOf?.length) {
        schema.allOf = definition.exactlyOneOf.map((group) => ({
            oneOf: group.map((field) => ({ required: [field] })),
        }));
    }
    return schema;
}
export function actionToolParameters(action) {
    return Type.Unsafe(actionPayloadSchema(action));
}
