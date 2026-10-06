import { type ToolPluginExecutionContext } from "openclaw/plugin-sdk/tool-plugin";
import { type RuleProposalStore } from "./rules.js";
type CalendarPluginApi = ToolPluginExecutionContext["api"];
export declare function ruleProposalStore(api: CalendarPluginApi): RuleProposalStore;
declare const entry: import("openclaw/plugin-sdk/tool-plugin").DefinedToolPluginEntry;
export default entry;
