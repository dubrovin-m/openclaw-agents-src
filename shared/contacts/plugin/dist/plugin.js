import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { ACTIONS, executeContactctl } from "./index.js";
import { CONTACT_DATE_REMINDER_DISPATCH_TOOL, createImportantDateDispatchTool, importantDateDispatchParameters, registerImportantDateRuntime, } from "./important-date-runtime.js";
const personId = Type.String({ pattern: "^P-[1-9]\\d*$" });
const dateId = Type.String({ pattern: "^DATE-[1-9]\\d*$" });
const groupId = Type.String({ pattern: "^PG-[1-9]\\d*$" });
const operationKey = Type.String({ minLength: 1, maxLength: 500 });
const shortText = Type.String({ minLength: 1, maxLength: 500 });
const nullableText = Type.Union([shortText, Type.Null()]);
const dateType = Type.Union([Type.Literal("BIRTHDAY"), Type.Literal("ANNIVERSARY"), Type.Literal("OTHER")]);
const nullableYear = Type.Union([Type.Integer({ minimum: 1000, maximum: 9999 }), Type.Null()]);
const reminderSpec = Type.Union([
    Type.Object({ offset_value: Type.Integer({ minimum: 0, maximum: 3650 }), offset_unit: Type.Literal("DAYS") }, { additionalProperties: false }),
    Type.Object({ offset_value: Type.Integer({ minimum: 0, maximum: 520 }), offset_unit: Type.Literal("WEEKS") }, { additionalProperties: false }),
    Type.Object({ offset_value: Type.Integer({ minimum: 0, maximum: 120 }), offset_unit: Type.Literal("MONTHS") }, { additionalProperties: false }),
]);
const reminders = Type.Array(reminderSpec, { maxItems: 20 });
const personReferenceFields = {
    person: shortText,
    organization: Type.Optional(shortText),
    title: Type.Optional(shortText),
};
export const CONTACT_SCHEMAS = {
    contact_search: Type.Object({ query: shortText, organization: Type.Optional(shortText), title: Type.Optional(shortText), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }),
    contact_resolve: Type.Object({ reference: shortText, organization: Type.Optional(shortText), title: Type.Optional(shortText) }, { additionalProperties: false }),
    contact_get: Type.Object({ id: personId }, { additionalProperties: false }),
    contact_create: Type.Object({ operation_key: operationKey, display_name: shortText, organization: Type.Optional(shortText), title: Type.Optional(shortText) }, { additionalProperties: false }),
    contact_update: Type.Object({ operation_key: operationKey, id: personId, display_name: Type.Optional(shortText), organization: Type.Optional(nullableText), title: Type.Optional(nullableText) }, { additionalProperties: false, minProperties: 3 }),
    contact_rename: Type.Object({ operation_key: operationKey, id: personId, display_name: shortText }, { additionalProperties: false }),
    contact_alias_add: Type.Object({ operation_key: operationKey, id: personId, alias: shortText }, { additionalProperties: false }),
    contact_alias_remove: Type.Object({ operation_key: operationKey, id: personId, alias: shortText }, { additionalProperties: false }),
    contact_merge: Type.Object({ operation_key: operationKey, from_id: personId, into_id: personId }, { additionalProperties: false }),
    contact_group_list: Type.Object({}, { additionalProperties: false }),
    contact_group_get: Type.Object({ id: groupId }, { additionalProperties: false }),
    contact_group_create: Type.Object({ operation_key: operationKey, display_name: shortText }, { additionalProperties: false }),
    contact_group_rename: Type.Object({ operation_key: operationKey, id: groupId, display_name: shortText }, { additionalProperties: false }),
    contact_group_member_add: Type.Object({ operation_key: operationKey, group_id: groupId, person: shortText }, { additionalProperties: false }),
    contact_group_member_remove: Type.Object({ operation_key: operationKey, group_id: groupId, person: shortText }, { additionalProperties: false }),
    contact_date_create: Type.Object({
        operation_key: operationKey, ...personReferenceFields, type: dateType, year: Type.Optional(nullableYear),
        month: Type.Integer({ minimum: 1, maximum: 12 }), day: Type.Integer({ minimum: 1, maximum: 31 }), annual: Type.Optional(Type.Boolean()), reminders,
    }, { additionalProperties: false }),
    contact_date_list: Type.Object({
        person: Type.Optional(shortText), organization: Type.Optional(shortText), title: Type.Optional(shortText), type: Type.Optional(dateType),
    }, { additionalProperties: false }),
    contact_date_update: Type.Object({
        operation_key: operationKey, id: dateId, type: Type.Optional(dateType), year: Type.Optional(nullableYear),
        month: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), day: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })), annual: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false, minProperties: 3 }),
    contact_date_reminders_set: Type.Object({ operation_key: operationKey, id: dateId, reminders }, { additionalProperties: false }),
    contact_date_delete: Type.Object({ operation_key: operationKey, id: dateId }, { additionalProperties: false }),
    contact_date_upcoming: Type.Object({
        from_date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), horizon_days: Type.Integer({ minimum: 0, maximum: 730 }),
        person: Type.Optional(shortText), organization: Type.Optional(shortText), title: Type.Optional(shortText), type: Type.Optional(dateType),
    }, { additionalProperties: false }),
};
const meta = {
    contact_search: { label: "Contact search", description: "Search shared canonical Person identities by name, alias, organization, or title." },
    contact_resolve: { label: "Contact resolve", description: "Resolve a Person reference deterministically to MATCH, AMBIGUOUS, or NOT_FOUND." },
    contact_get: { label: "Contact inspect", description: "Inspect one stable P-* identity, including historical merge redirect when present." },
    contact_create: { label: "Contact create", description: "Create one explicit durable Person identity after user-authorized creation." },
    contact_update: { label: "Contact update", description: "Update bounded identifying facts for an existing canonical Person." },
    contact_rename: { label: "Contact rename", description: "Rename an existing canonical Person while preserving the prior useful name as an alias." },
    contact_alias_add: { label: "Contact alias add", description: "Add a persisted Person alias. Alias ambiguity is allowed and must be surfaced on resolution." },
    contact_alias_remove: { label: "Contact alias remove", description: "Remove one persisted alias from a canonical Person." },
    contact_merge: { label: "Contact merge", description: "Confirm that two P-* identities represent one Person; preserve the source as a MERGED historical redirect." },
    contact_group_list: { label: "Person Group list", description: "List reusable shared Person Groups without inferring organizational structure." },
    contact_group_get: { label: "Person Group inspect", description: "Inspect one stable PG-* group and its current canonical Person members." },
    contact_group_create: { label: "Person Group create", description: "Create one reusable named Person Group with stable PG-* identity and no implicit members." },
    contact_group_rename: { label: "Person Group rename", description: "Rename one Person Group without changing its stable PG-* identity or membership." },
    contact_group_member_add: { label: "Person Group member add", description: "Add one existing canonical Person to one existing Person Group; never create a Person implicitly." },
    contact_group_member_remove: { label: "Person Group member remove", description: "Remove one canonical Person from one existing Person Group without changing either identity." },
    contact_date_create: { label: "Important date create", description: "Create an important date for an existing Person. The reminders array is mandatory and represents the user's explicit reminder decision; if the user did not specify whether reminders are wanted, ask before calling this tool. Use [] only after the user explicitly chose no reminders." },
    contact_date_list: { label: "Important date list", description: "List stored important dates and their explicit reminder policies, optionally for one Person or date type." },
    contact_date_update: { label: "Important date update", description: "Update the date facts of one existing DATE-* record without changing its reminder policy." },
    contact_date_reminders_set: { label: "Important date reminders", description: "Replace the explicit reminder policy for one ImportantDate. An empty array means the user explicitly chose no reminders." },
    contact_date_delete: { label: "Important date delete", description: "Delete one existing ImportantDate and its reminder policy." },
    contact_date_upcoming: { label: "Upcoming important dates", description: "List ImportantDate occurrences within an explicit date horizon, with days until each occurrence." },
};
const entry = defineToolPlugin({
    id: "contacts", name: "Contacts", description: "Bounded shared Person identity, Person Group, and Important Dates operations.",
    tools: (tool) => [
        ...Object.keys(ACTIONS).map(action => tool({
            name: action, label: meta[action].label, description: meta[action].description, parameters: CONTACT_SCHEMAS[action],
            factory: () => ({ name: action, label: meta[action].label, description: meta[action].description, parameters: CONTACT_SCHEMAS[action], catalogMode: "direct-only", execute: async (_toolCallId, params, signal) => jsonResult(await executeContactctl(action, params, { signal })) }),
        })),
        tool({
            name: CONTACT_DATE_REMINDER_DISPATCH_TOOL,
            label: "Important Dates Reminder Dispatcher",
            description: "Scheduler-only Important Dates delivery operation.",
            parameters: importantDateDispatchParameters,
            optional: true,
            factory: ({ toolContext }) => createImportantDateDispatchTool(toolContext),
        }),
    ],
});
const registerTools = entry.register;
entry.register = (api) => { registerTools(api); registerImportantDateRuntime(api); };
export default entry;
