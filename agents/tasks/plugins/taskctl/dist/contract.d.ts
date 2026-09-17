import { Type } from "typebox";
type JsonSchema = Record<string, unknown>;
export type ActionDefinition = {
    argv: readonly string[];
    allowed: readonly string[];
    required?: readonly string[];
    exactlyOneOf?: readonly (readonly string[])[];
    label: string;
    description: string;
};
export declare const ACTION_REGISTRY: Readonly<{
    readonly task_update: {
        readonly argv: readonly ["task", "update"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id", "title", "assignee", "assignee_id", "create_assignee", "due_date", "due_time", "reason"];
        readonly label: "Task update";
        readonly description: "Apply a reversible field update to one existing OPEN Task; status transitions and Project association are not accepted.";
    };
    readonly task_complete: {
        readonly argv: readonly ["task", "complete"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Task complete";
        readonly description: "Complete one existing OPEN Task through the deterministic completion transition.";
    };
    readonly task_cancel: {
        readonly argv: readonly ["task", "cancel"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Task cancel";
        readonly description: "Cancel one existing OPEN Task; call only after the Task Agent behavioral confirmation requirement is satisfied.";
    };
    readonly inbox_add: {
        readonly argv: readonly ["inbox", "add"];
        readonly required: readonly ["operation_key", "content", "capture_key"];
        readonly allowed: readonly ["operation_key", "content", "capture_key"];
        readonly label: "Inbox add";
        readonly description: "Capture one new Inbox item for later processing without creating a Task or Project.";
    };
    readonly inbox_list: {
        readonly argv: readonly ["inbox", "list"];
        readonly allowed: readonly ["limit"];
        readonly label: "Inbox list";
        readonly description: "List unresolved Inbox items, optionally bounded by a result limit.";
    };
    readonly inbox_get: {
        readonly argv: readonly ["inbox", "get"];
        readonly required: readonly ["id"];
        readonly allowed: readonly ["id"];
        readonly label: "Inbox get";
        readonly description: "Read one Inbox item by its stable Inbox identifier.";
    };
    readonly inbox_discard: {
        readonly argv: readonly ["inbox", "discard"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Inbox discard";
        readonly description: "Discard one Inbox item without creating any Task.";
    };
    readonly inbox_commit: {
        readonly argv: readonly ["inbox", "commit"];
        readonly required: readonly ["operation_key", "id", "tasks"];
        readonly allowed: readonly ["operation_key", "id", "tasks"];
        readonly label: "Inbox commit";
        readonly description: "Atomically create the confirmed Task set, including optional resolved Project associations, and remove that Inbox item.";
    };
    readonly task_create: {
        readonly argv: readonly ["task", "create"];
        readonly required: readonly ["operation_key", "title", "assignee"];
        readonly allowed: readonly ["operation_key", "title", "assignee", "create_assignee", "status", "due_date", "due_time", "labels", "project_id"];
        readonly label: "Task create";
        readonly description: "Create one Task with an explicit assignee and optional deadline, initial status, Labels, and an already resolved ACTIVE Project association. The assignee field accepts either a canonical P-* identifier returned by Person resolution or an unambiguous display-name reference.";
    };
    readonly task_list: {
        readonly argv: readonly ["task", "list"];
        readonly allowed: readonly ["status", "assignee", "assignee_id", "label", "view", "due_on", "due_until", "search", "limit"];
        readonly label: "Task list";
        readonly description: "List Tasks using structured status, assignee, Label, deadline, view, text, and limit filters.";
    };
    readonly task_search: {
        readonly argv: readonly ["task", "search"];
        readonly required: readonly ["search"];
        readonly allowed: readonly ["search", "status", "assignee", "assignee_id", "label", "view", "due_on", "due_until", "limit"];
        readonly label: "Task search";
        readonly description: "Search Tasks by text with optional status, assignee, Label, deadline, view, and limit filters.";
    };
    readonly task_get: {
        readonly argv: readonly ["task", "get"];
        readonly required: readonly ["id"];
        readonly allowed: readonly ["id"];
        readonly label: "Task get";
        readonly description: "Read the compact current record for one Task, including its current Project association when present.";
    };
    readonly task_detail: {
        readonly argv: readonly ["task", "detail"];
        readonly required: readonly ["id"];
        readonly allowed: readonly ["id"];
        readonly label: "Task detail";
        readonly description: "Read the detailed current state and related context for one Task, including its current Project association.";
    };
    readonly task_history: {
        readonly argv: readonly ["task", "history"];
        readonly required: readonly ["id"];
        readonly allowed: readonly ["id"];
        readonly label: "Task history";
        readonly description: "Read the chronological Task mutation history; Project-association history is not recorded in this version.";
    };
    readonly reminder_create: {
        readonly argv: readonly ["reminder", "create"];
        readonly required: readonly ["operation_key", "trigger_date", "trigger_time"];
        readonly allowed: readonly ["operation_key", "task_id", "text", "trigger_date", "trigger_time"];
        readonly exactlyOneOf: readonly [readonly ["task_id", "text"]];
        readonly label: "Reminder create";
        readonly description: "Create one one-shot Reminder, either linked to one existing OPEN Task or carrying standalone text, at one explicit Europe/Moscow date and time.";
    };
    readonly reminder_list: {
        readonly argv: readonly ["reminder", "list"];
        readonly allowed: readonly ["limit"];
        readonly label: "Reminder list";
        readonly description: "List ACTIVE one-shot Reminders ordered by trigger time.";
    };
    readonly reminder_reschedule: {
        readonly argv: readonly ["reminder", "reschedule"];
        readonly required: readonly ["operation_key", "id", "trigger_date", "trigger_time"];
        readonly allowed: readonly ["operation_key", "id", "trigger_date", "trigger_time"];
        readonly label: "Reminder reschedule";
        readonly description: "Move one ACTIVE Reminder to one explicit future Europe/Moscow date and time without changing its Task or text identity.";
    };
    readonly reminder_cancel: {
        readonly argv: readonly ["reminder", "cancel"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Reminder cancel";
        readonly description: "Close one ACTIVE Reminder without changing a linked Task.";
    };
    readonly recurrence_create: {
        readonly argv: readonly ["recurrence", "create"];
        readonly required: readonly ["operation_key", "mode", "rule"];
        readonly allowed: readonly ["operation_key", "mode", "rule", "seed_task_id", "title", "assignee_id", "label_ids", "target_project_id", "due_time", "first_due_date"];
        readonly label: "Recurrence create";
        readonly description: "Create one deterministic Recurrence, optionally seeding it from one existing OPEN Task; no scheduler administration is exposed.";
    };
    readonly recurrence_list: {
        readonly argv: readonly ["recurrence", "list"];
        readonly allowed: readonly ["status", "limit"];
        readonly label: "Recurrence list";
        readonly description: "List Recurrences; defaults to ACTIVE and supports explicit lifecycle filters.";
    };
    readonly recurrence_get: {
        readonly argv: readonly ["recurrence", "get"];
        readonly required: readonly ["id"];
        readonly allowed: readonly ["id"];
        readonly label: "Recurrence get";
        readonly description: "Read the compact current state of one Recurrence by canonical R-* identifier.";
    };
    readonly recurrence_detail: {
        readonly argv: readonly ["recurrence", "detail"];
        readonly required: readonly ["id"];
        readonly allowed: readonly ["id"];
        readonly label: "Recurrence detail";
        readonly description: "Read one Recurrence with current rule, Task template, occurrence references, and cycle-resolution state.";
    };
    readonly recurrence_history: {
        readonly argv: readonly ["recurrence", "history"];
        readonly required: readonly ["id"];
        readonly allowed: readonly ["id"];
        readonly label: "Recurrence history";
        readonly description: "Read reconstructible Recurrence-scoped lifecycle, rule, template, and cycle history.";
    };
    readonly recurrence_update: {
        readonly argv: readonly ["recurrence", "update"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id", "title", "assignee_id", "label_ids", "target_project_id", "due_time", "rule", "cycle_anchor_date"];
        readonly label: "Recurrence update";
        readonly description: "Update future Recurrence rule/template state or explicitly establish a new AFTER_COMPLETION cycle anchor; mode is immutable.";
    };
    readonly recurrence_pause: {
        readonly argv: readonly ["recurrence", "pause"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Recurrence pause";
        readonly description: "Pause one ACTIVE Recurrence without rewriting generated Tasks.";
    };
    readonly recurrence_resume: {
        readonly argv: readonly ["recurrence", "resume"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Recurrence resume";
        readonly description: "Resume one PAUSED Recurrence; paused calendar slots are skipped and an AFTER_COMPLETION terminal occurrence starts a new cycle from resume date.";
    };
    readonly recurrence_cancel: {
        readonly argv: readonly ["recurrence", "cancel"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Recurrence cancel";
        readonly description: "Cancel one Recurrence terminally without changing historical generated Tasks; call only after behavioral confirmation.";
    };
    readonly project_create: {
        readonly argv: readonly ["project", "create"];
        readonly required: readonly ["operation_key", "title"];
        readonly allowed: readonly ["operation_key", "title"];
        readonly label: "Project create";
        readonly description: "Create one lightweight Operational Project with ACTIVE lifecycle state and no implicit Tasks.";
    };
    readonly project_list: {
        readonly argv: readonly ["project", "list"];
        readonly allowed: readonly ["status", "search", "limit"];
        readonly label: "Project list";
        readonly description: "List Operational Projects; defaults to ACTIVE and may filter lifecycle or search Project titles.";
    };
    readonly project_get: {
        readonly argv: readonly ["project", "get"];
        readonly required: readonly ["id"];
        readonly allowed: readonly ["id"];
        readonly label: "Project get";
        readonly description: "Read one Operational Project with current associated Tasks and derived Task-state counts.";
    };
    readonly project_rename: {
        readonly argv: readonly ["project", "rename"];
        readonly required: readonly ["operation_key", "id", "title"];
        readonly allowed: readonly ["operation_key", "id", "title"];
        readonly label: "Project rename";
        readonly description: "Rename one existing Operational Project without changing lifecycle or Task associations.";
    };
    readonly project_complete: {
        readonly argv: readonly ["project", "complete"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Project complete";
        readonly description: "Explicitly transition one ACTIVE Operational Project to DONE without changing associated Tasks.";
    };
    readonly project_cancel: {
        readonly argv: readonly ["project", "cancel"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Project cancel";
        readonly description: "Explicitly transition one ACTIVE Operational Project to CANCELLED without changing associated Tasks.";
    };
    readonly task_project_set: {
        readonly argv: readonly ["task-project", "set"];
        readonly required: readonly ["operation_key", "task_id", "project_id"];
        readonly allowed: readonly ["operation_key", "task_id", "project_id"];
        readonly label: "Task Project set";
        readonly description: "Atomically set, move, or clear one Task's single Operational Project association; non-null destinations must be existing ACTIVE Projects.";
    };
    readonly person_list: {
        readonly argv: readonly ["person", "list"];
        readonly allowed: readonly [];
        readonly label: "Person list";
        readonly description: "List canonical People known to the Task Agent.";
    };
    readonly person_resolve: {
        readonly argv: readonly ["person", "resolve"];
        readonly required: readonly ["reference"];
        readonly allowed: readonly ["reference"];
        readonly label: "Person resolve";
        readonly description: "Resolve a person name or alias reference to canonical Person candidates.";
    };
    readonly person_create: {
        readonly argv: readonly ["person", "create"];
        readonly required: readonly ["operation_key", "display_name"];
        readonly allowed: readonly ["operation_key", "display_name"];
        readonly label: "Person create";
        readonly description: "Create one canonical Person with the supplied display name.";
    };
    readonly person_rename: {
        readonly argv: readonly ["person", "rename"];
        readonly required: readonly ["operation_key", "id", "display_name"];
        readonly allowed: readonly ["operation_key", "id", "display_name"];
        readonly label: "Person rename";
        readonly description: "Change the canonical display name of one existing Person.";
    };
    readonly person_alias_add: {
        readonly argv: readonly ["person", "alias_add"];
        readonly required: readonly ["operation_key", "id", "alias"];
        readonly allowed: readonly ["operation_key", "id", "alias"];
        readonly label: "Person alias add";
        readonly description: "Add one alias that resolves to an existing canonical Person.";
    };
    readonly person_alias_remove: {
        readonly argv: readonly ["person", "alias_remove"];
        readonly required: readonly ["operation_key", "id", "alias"];
        readonly allowed: readonly ["operation_key", "id", "alias"];
        readonly label: "Person alias remove";
        readonly description: "Remove one alias from an existing canonical Person.";
    };
    readonly person_merge: {
        readonly argv: readonly ["person", "merge"];
        readonly required: readonly ["operation_key", "from_id", "into_id"];
        readonly allowed: readonly ["operation_key", "from_id", "into_id"];
        readonly label: "Person merge";
        readonly description: "Merge one duplicate Person into another canonical Person while preserving Task relationships.";
    };
    readonly label_list: {
        readonly argv: readonly ["label", "list"];
        readonly allowed: readonly [];
        readonly label: "Label list";
        readonly description: "List canonical Labels known to the Task Agent.";
    };
    readonly label_resolve: {
        readonly argv: readonly ["label", "resolve"];
        readonly required: readonly ["reference"];
        readonly allowed: readonly ["reference"];
        readonly label: "Label resolve";
        readonly description: "Resolve a Label name or alias reference to canonical Label candidates.";
    };
    readonly label_create: {
        readonly argv: readonly ["label", "create"];
        readonly required: readonly ["operation_key", "display_name"];
        readonly allowed: readonly ["operation_key", "display_name", "emoji"];
        readonly label: "Label create";
        readonly description: "Create one canonical Label with an optional presentation emoji.";
    };
    readonly label_rename: {
        readonly argv: readonly ["label", "rename"];
        readonly required: readonly ["operation_key", "id", "display_name"];
        readonly allowed: readonly ["operation_key", "id", "display_name"];
        readonly label: "Label rename";
        readonly description: "Change the canonical display name of one existing Label.";
    };
    readonly label_set_emoji: {
        readonly argv: readonly ["label", "set_emoji"];
        readonly required: readonly ["operation_key", "id", "emoji"];
        readonly allowed: readonly ["operation_key", "id", "emoji"];
        readonly label: "Label set emoji";
        readonly description: "Set, change, or clear the presentation emoji of one canonical Label.";
    };
    readonly label_alias_add: {
        readonly argv: readonly ["label", "alias_add"];
        readonly required: readonly ["operation_key", "id", "alias"];
        readonly allowed: readonly ["operation_key", "id", "alias"];
        readonly label: "Label alias add";
        readonly description: "Add one alias that resolves to an existing canonical Label.";
    };
    readonly label_alias_remove: {
        readonly argv: readonly ["label", "alias_remove"];
        readonly required: readonly ["operation_key", "id", "alias"];
        readonly allowed: readonly ["operation_key", "id", "alias"];
        readonly label: "Label alias remove";
        readonly description: "Remove one alias from an existing canonical Label.";
    };
    readonly label_delete: {
        readonly argv: readonly ["label", "delete"];
        readonly required: readonly ["operation_key", "id"];
        readonly allowed: readonly ["operation_key", "id"];
        readonly label: "Label delete";
        readonly description: "Delete one canonical Label and its Task associations without deleting or rewriting Tasks.";
    };
    readonly label_merge: {
        readonly argv: readonly ["label", "merge"];
        readonly required: readonly ["operation_key", "from_id", "into_id"];
        readonly allowed: readonly ["operation_key", "from_id", "into_id"];
        readonly label: "Label merge";
        readonly description: "Merge one duplicate Label into another canonical Label while preserving Task associations.";
    };
    readonly term_list: {
        readonly argv: readonly ["term", "list"];
        readonly allowed: readonly [];
        readonly label: "Term list";
        readonly description: "List explicitly stored Task Agent terminology aliases and expansions.";
    };
    readonly term_resolve: {
        readonly argv: readonly ["term", "resolve"];
        readonly required: readonly ["alias"];
        readonly allowed: readonly ["alias"];
        readonly label: "Term resolve";
        readonly description: "Resolve one stored Task Agent terminology alias to its expansion.";
    };
    readonly term_set: {
        readonly argv: readonly ["term", "set"];
        readonly required: readonly ["operation_key", "alias", "expansion"];
        readonly allowed: readonly ["operation_key", "alias", "expansion"];
        readonly label: "Term set";
        readonly description: "Create or replace one explicitly confirmed Task Agent terminology alias and expansion.";
    };
    readonly term_remove: {
        readonly argv: readonly ["term", "remove"];
        readonly required: readonly ["operation_key", "alias"];
        readonly allowed: readonly ["operation_key", "alias"];
        readonly label: "Term remove";
        readonly description: "Remove one stored Task Agent terminology alias.";
    };
    readonly task_label_add: {
        readonly argv: readonly ["task-label", "add"];
        readonly required: readonly ["operation_key", "task_id", "label_id"];
        readonly allowed: readonly ["operation_key", "task_id", "label_id"];
        readonly label: "Task Label add";
        readonly description: "Attach one already resolved canonical Label to one Task by canonical Label identifier.";
    };
    readonly task_label_remove: {
        readonly argv: readonly ["task-label", "remove"];
        readonly required: readonly ["operation_key", "task_id", "label_id"];
        readonly allowed: readonly ["operation_key", "task_id", "label_id"];
        readonly label: "Task Label remove";
        readonly description: "Detach one already resolved canonical Label from one Task without deleting the canonical Label.";
    };
    readonly comment_add: {
        readonly argv: readonly ["comment", "add"];
        readonly required: readonly ["operation_key", "task_id", "content"];
        readonly allowed: readonly ["operation_key", "task_id", "content"];
        readonly label: "Comment add";
        readonly description: "Append one immutable chronological comment to an existing Task.";
    };
    readonly comment_list: {
        readonly argv: readonly ["comment", "list"];
        readonly required: readonly ["task_id"];
        readonly allowed: readonly ["task_id"];
        readonly label: "Comment list";
        readonly description: "List chronological comments attached to one Task.";
    };
    readonly ref_resolve: {
        readonly argv: readonly ["ref", "resolve"];
        readonly required: readonly ["number"];
        readonly allowed: readonly ["number", "context"];
        readonly label: "Reference resolve";
        readonly description: "Resolve a short numeric reference to a stable Task or Inbox identifier within the requested context.";
    };
}>;
export type TaskctlAction = keyof typeof ACTION_REGISTRY;
export declare const TASKCTL_ACTIONS: readonly ("task_update" | "task_complete" | "task_cancel" | "inbox_add" | "inbox_list" | "inbox_get" | "inbox_discard" | "inbox_commit" | "task_create" | "task_list" | "task_search" | "task_get" | "task_detail" | "task_history" | "reminder_create" | "reminder_list" | "reminder_reschedule" | "reminder_cancel" | "recurrence_create" | "recurrence_list" | "recurrence_get" | "recurrence_detail" | "recurrence_history" | "recurrence_update" | "recurrence_pause" | "recurrence_resume" | "recurrence_cancel" | "project_create" | "project_list" | "project_get" | "project_rename" | "project_complete" | "project_cancel" | "task_project_set" | "person_list" | "person_resolve" | "person_create" | "person_rename" | "person_alias_add" | "person_alias_remove" | "person_merge" | "label_list" | "label_resolve" | "label_create" | "label_rename" | "label_set_emoji" | "label_alias_add" | "label_alias_remove" | "label_delete" | "label_merge" | "term_list" | "term_resolve" | "term_set" | "term_remove" | "task_label_add" | "task_label_remove" | "comment_add" | "comment_list" | "ref_resolve")[];
export declare function getActionDefinition(action: TaskctlAction): ActionDefinition;
export declare function actionPayloadSchema(action: TaskctlAction): JsonSchema;
export declare function actionToolParameters(action: TaskctlAction): Type.TUnsafe<Record<string, unknown>>;
export {};
