import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { TASKCTL_ACTIONS, actionToolParameters, getActionDefinition } from "./contract.js";
import {
  TASK_DAILY_REVIEW_TOOL,
  dailyReviewParameters,
} from "./daily-review.js";
import {
  createDailyReviewTool,
  registerDailyReviewSchedulerAccess,
} from "./daily-review-runtime.js";
import { executeTaskctl } from "./index.js";
import { TASK_MANAGEMENT_REVIEW_TOOL, createManagementReviewTool, managementReviewParameters } from "./management-review.js";
import {
  TASK_PRODUCTION_CONTROL_TOOL,
  executeProductionControl,
  productionControlApproval,
  productionControlParameters,
} from "./production-control.js";

const entry = defineToolPlugin({
  id: "taskctl",
  name: "Taskctl",
  description: "Typed Task Agent data access plus bounded Task production-control operations.",
  tools: (tool) => [
    ...TASKCTL_ACTIONS.map((action) => {
      const definition = getActionDefinition(action);
      return tool({
        name: action,
        label: definition.label,
        description: definition.description,
        parameters: actionToolParameters(action),
        optional: true,
        execute: async (params, _config, context) => executeTaskctl(action, params, { signal: context.signal }),
      });
    }),
    tool({
      name: TASK_PRODUCTION_CONTROL_TOOL,
      label: "Task production control",
      description: "Inspect Task Agent production status, run bounded diagnostics, or request an exact-revision deterministic deployment.",
      parameters: productionControlParameters,
      optional: true,
      execute: async (params, _config, context) => executeProductionControl(params, { signal: context.signal }),
    }),
    tool({
      name: TASK_DAILY_REVIEW_TOOL,
      label: "Task Daily Review",
      description: "Build one fail-closed scheduler-only Daily Review snapshot and semantic duplicate warning set without Task mutations.",
      parameters: dailyReviewParameters,
      optional: true,
      factory: ({ api, toolContext }) => createDailyReviewTool(api, toolContext),
    }),
    tool({
      name: TASK_MANAGEMENT_REVIEW_TOOL,
      label: "Task Management Review",
      description: "Build one fail-closed scheduler-only weekday management report without Task mutations.",
      parameters: managementReviewParameters,
      optional: true,
      factory: ({ toolContext }) => createManagementReviewTool(toolContext),
    }),
  ],
});

const registerTools = entry.register;
entry.register = (api) => {
  registerTools(api);
  registerDailyReviewSchedulerAccess(api);
  api.on("before_tool_call", (event, context) => productionControlApproval(event, context));
};

export default entry;
