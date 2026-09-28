import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Value } from "typebox/value";
import { ACTION_REGISTRY, actionToolParameters, getActionDefinition, type TaskctlAction } from "./contract.js";

export { ACTION_REGISTRY, TASKCTL_ACTIONS, type TaskctlAction } from "./contract.js";

export const TASKCTL_EXECUTABLE = "/home/dubrovin/.local/bin/taskctl";
export const TASKCTL_TIMEOUT_MS = 10_000;
export const TASKCTL_OUTPUT_LIMIT_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

function validationError(message:string, details:JsonObject={}) { return { ok:false, error:{ code:"TASKCTL_VALIDATION_ERROR", message, ...details } }; }
const has=(o:JsonObject,k:string)=>Object.hasOwn(o,k);
const validInternalString=(v:unknown,max:number)=>typeof v==="string"&&v.trim().length>0&&v.trim().length<=max;
const isObject=(v:unknown):v is JsonObject=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const isRealDate=(v:unknown)=>{if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(v+"T00:00:00Z");return!Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;};
const REAL_DATE_FIELDS=new Set(["due_date","due_on","due_until","first_due_date","cycle_anchor_date","trigger_date","start_date"]);

function semanticTreeError(value:unknown,path="payload"):string|null {
  if(typeof value==="string")return value.trim().length===0?`${path} must not be blank`:null;
  if(Array.isArray(value)){for(let i=0;i<value.length;i+=1){const error=semanticTreeError(value[i],`${path}[${i}]`);if(error)return error;}return null;}
  if(!isObject(value))return null;
  for(const [key,child] of Object.entries(value)){
    const childPath=`${path}.${key}`;
    if(REAL_DATE_FIELDS.has(key)&&child!==null&&!isRealDate(child))return `${key} must be a real YYYY-MM-DD date`;
    const error=semanticTreeError(child,childPath);if(error)return error;
  }
  return null;
}

function labelSpecSemanticError(value:unknown):string|null {
  if(typeof value==="string")return null;
  if(!isObject(value))return null;
  const refs=["id","name"].filter(key=>has(value,key));
  if(refs.length!==1)return"label specification must contain exactly one of id or name";
  if(has(value,"create")&&!has(value,"name"))return"label create requires a label name";
  return null;
}

function labelsSemanticError(value:unknown):string|null {
  if(!Array.isArray(value))return null;
  for(const label of value){const error=labelSpecSemanticError(label);if(error)return error;}
  return null;
}

function semanticRefinementError(action:TaskctlAction,obj:JsonObject):string|null {
  const treeError=semanticTreeError(obj);if(treeError)return treeError;
  if(typeof obj.emoji==="string"&&/[\r\n]/.test(obj.emoji))return"emoji must not contain line breaks";

  const rule=getActionDefinition(action);
  for(const group of rule.exactlyOneOf??[]){const present=group.filter(key=>has(obj,key));if(present.length!==1)return"payload must include exactly one of "+group.join(", ")+" for "+action;}
  for(const group of [["assignee","assignee_id"],["label","label_id"]])if(group.every(key=>has(obj,key)))return"payload contains mutually exclusive fields for "+action;

  if(action==="task_update"&&Object.keys(obj).every(key=>["operation_key","id","reason"].includes(key)))return"task_update requires at least one mutable task field";
  if(action==="task_update"&&has(obj,"reason")&&!has(obj,"due_date")&&!has(obj,"due_time"))return"reason is allowed only with a deadline change";
  if(action==="deadline_request_create"&&!has(obj,"due_date")&&!has(obj,"due_time"))return"deadline_request_create requires due_date and/or due_time";
  if(action==="task_create"&&obj.due_time!==undefined&&obj.due_time!==null&&(!has(obj,"due_date")||obj.due_date===null))return"due_time requires due_date";

  if(has(obj,"labels")){const error=labelsSemanticError(obj.labels);if(error)return error;}
  if(action==="inbox_commit"&&Array.isArray(obj.tasks)){
    for(const task of obj.tasks){
      if(!isObject(task))continue;
      if(task.due_time!==undefined&&task.due_time!==null&&(!has(task,"due_date")||task.due_date===null))return"due_time requires due_date in committed task";
      if(has(task,"labels")){const error=labelsSemanticError(task.labels);if(error)return error;}
    }
  }

  if(action==="recurrence_create"){
    const seeded=has(obj,"seed_task_id");
    if(seeded&&["title","assignee_id","label_ids","target_project_id","due_time","first_due_date"].some(key=>has(obj,key)))return"seed Recurrence derives its template from the existing Task";
    if(!seeded&&(!has(obj,"title")||!has(obj,"assignee_id")))return"non-seed Recurrence requires title and assignee_id";
    const recurrenceRuleObject=obj.rule as JsonObject;
    const calendarShaped=typeof recurrenceRuleObject?.kind==="string";
    if(obj.mode==="CALENDAR"&&!calendarShaped)return"CALENDAR Recurrence requires a CALENDAR rule";
    if(obj.mode==="AFTER_COMPLETION"&&calendarShaped)return"AFTER_COMPLETION Recurrence requires an interval/unit rule";
    if(obj.mode==="CALENDAR"&&has(obj,"first_due_date"))return"CALENDAR Recurrence does not accept first_due_date";
    if(obj.mode==="AFTER_COMPLETION"&&!seeded&&!has(obj,"first_due_date"))return"AFTER_COMPLETION Recurrence requires first_due_date without a seed";
  }
  if(action==="recurrence_update"&&Object.keys(obj).every(key=>["operation_key","id"].includes(key)))return"recurrence_update requires at least one mutable field";
  if(action==="recurrence_update"&&has(obj,"cycle_anchor_date")&&Object.keys(obj).some(key=>!["operation_key","id","cycle_anchor_date"].includes(key)))return"cycle_anchor_date must be a standalone recurrence update";
  if(has(obj,"create_assignee")&&!has(obj,"assignee"))return"create_assignee requires assignee";
  if(has(obj,"create_label")&&!has(obj,"label"))return"create_label requires label";
  return null;
}

export function validateAndSanitizePayload(action: unknown, payload: unknown): {ok:true;action:TaskctlAction;payload:JsonObject}|{ok:false;error:ReturnType<typeof validationError>} {
  if(typeof action!=="string" || !Object.hasOwn(ACTION_REGISTRY,action)) return {ok:false,error:validationError("Unknown taskctl action")};
  const a=action as TaskctlAction;
  if(!Value.Check(actionToolParameters(a),payload))return{ok:false,error:validationError("payload does not match structural contract for "+a)};
  const obj=payload as JsonObject;
  const semanticError=semanticRefinementError(a,obj);
  if(semanticError)return{ok:false,error:validationError(semanticError)};
  return{ok:true,action:a,payload:Object.fromEntries(Object.keys(obj).map(key=>[key,obj[key]]))};
}
export type TaskctlInvocation={executable:typeof TASKCTL_EXECUTABLE;argv:readonly string[];options:{shell:false;env:NodeJS.ProcessEnv;stdio:readonly["ignore","pipe","pipe"]}};
export function buildInvocation(action:TaskctlAction,payload:JsonObject):TaskctlInvocation{return{executable:TASKCTL_EXECUTABLE,argv:getActionDefinition(action).argv,options:{shell:false,env:{HOME:"/home/dubrovin",PATH:"/usr/bin:/bin",LANG:"C.UTF-8",TZ:"Europe/Moscow",TASKCTL_PAYLOAD:JSON.stringify(payload)},stdio:["ignore","pipe","pipe"]}};}
export type SpawnTaskctl=(executable:string,argv:readonly string[],options:TaskctlInvocation["options"])=>ChildProcessWithoutNullStreams;
type ProcessOutcome={exitCode:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string;timedOut:boolean;aborted:boolean;outputExceeded:boolean;spawnError?:string};
export type RunOptions={timeoutMs?:number;outputLimitBytes?:number;signal?:AbortSignal;spawnImpl?:SpawnTaskctl};
function structuredError(code:string,message:string,details:JsonObject={}){return{ok:false,error:{code,message,...details}};}
function appendChunk(current:Buffer[],chunk:Buffer|string,state:{bytes:number},limit:number){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);state.bytes+=b.byteLength;if(state.bytes<=limit)current.push(b);return state.bytes<=limit;}
export async function executeTaskctl(action:unknown,payload:unknown,options:RunOptions={}){const v=validateAndSanitizePayload(action,payload);if(!v.ok)return v.error;return runTaskctl(v.action,v.payload,options);}
async function runInvocation(inv:TaskctlInvocation,options:RunOptions={}){
  const timeoutMs=options.timeoutMs??TASKCTL_TIMEOUT_MS,limit=options.outputLimitBytes??TASKCTL_OUTPUT_LIMIT_BYTES,spawnImpl=options.spawnImpl??(spawn as unknown as SpawnTaskctl);
  const outcome=await new Promise<ProcessOutcome>(resolve=>{let child:ChildProcessWithoutNullStreams;try{child=spawnImpl(inv.executable,inv.argv,inv.options);}catch(error){resolve({exitCode:null,signal:null,stdout:"",stderr:"",timedOut:false,aborted:false,outputExceeded:false,spawnError:error instanceof Error?error.message:String(error)});return;}const stdout:Buffer[]=[],stderr:Buffer[]=[];const so={bytes:0},se={bytes:0};let timedOut=false,aborted=false,outputExceeded=false,settled=false;const kill=()=>{if(!child.killed)child.kill("SIGKILL")};const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);timer.unref?.();const onAbort=()=>{aborted=true;kill();};if(options.signal?.aborted)onAbort();else options.signal?.addEventListener("abort",onAbort,{once:true});child.stdout.on("data",c=>{if(!appendChunk(stdout,c,so,limit)){outputExceeded=true;kill();}});child.stderr.on("data",c=>{if(!appendChunk(stderr,c,se,limit)){outputExceeded=true;kill();}});const finish=(exitCode:number|null,signal:NodeJS.Signals|null,spawnError?:string)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener("abort",onAbort);resolve({exitCode,signal,stdout:Buffer.concat(stdout).toString("utf8"),stderr:Buffer.concat(stderr).toString("utf8"),timedOut,aborted,outputExceeded,...(spawnError?{spawnError}:{})});};child.on("error",e=>finish(null,null,e.message));child.on("close",(c,s)=>finish(c,s));});
  if(outcome.spawnError)return structuredError("TASKCTL_SPAWN_ERROR","Failed to start taskctl",{detail:outcome.spawnError}); if(outcome.aborted)return structuredError("TASKCTL_ABORTED","taskctl call was aborted"); if(outcome.timedOut)return structuredError("TASKCTL_TIMEOUT","taskctl call timed out",{timeout_ms:timeoutMs}); if(outcome.outputExceeded)return structuredError("TASKCTL_OUTPUT_LIMIT","taskctl output exceeded the configured limit",{output_limit_bytes:limit});
  let parsed:unknown;try{parsed=JSON.parse(outcome.stdout);}catch{return structuredError("TASKCTL_INVALID_JSON","taskctl stdout was not valid JSON",{exit_code:outcome.exitCode,signal:outcome.signal,stderr:outcome.stderr.slice(0,4096)});} if(outcome.exitCode!==0||outcome.signal!==null||outcome.stderr.length>0)return structuredError("TASKCTL_PROCESS_ERROR","taskctl reported a process error",{exit_code:outcome.exitCode,signal:outcome.signal,stderr:outcome.stderr.slice(0,4096),taskctl:parsed}); return parsed;
}
export async function runTaskctl(action:TaskctlAction,payload:JsonObject,options:RunOptions={}){return runInvocation(buildInvocation(action,payload),options);}
export function buildDailyReviewSnapshotInvocation(boundaryIso:string):TaskctlInvocation{
  if(typeof boundaryIso!=="string"||!boundaryIso.trim())throw new Error("Daily Review snapshot boundary is required");
  const instant=new Date(boundaryIso);if(Number.isNaN(instant.getTime()))throw new Error("Daily Review snapshot boundary must be a valid ISO timestamp");
  const boundary=instant.toISOString();
  return{executable:TASKCTL_EXECUTABLE,argv:["review","snapshot"],options:{shell:false,env:{HOME:"/home/dubrovin",PATH:"/usr/bin:/bin",LANG:"C.UTF-8",TZ:"Europe/Moscow",TASKCTL_PAYLOAD:JSON.stringify({boundary})},stdio:["ignore","pipe","pipe"]}};
}
export async function runDailyReviewSnapshot(boundaryIso:string,options:RunOptions={}){return runInvocation(buildDailyReviewSnapshotInvocation(boundaryIso),{...options,outputLimitBytes:options.outputLimitBytes??2*1024*1024});}
export function buildManagementReviewSnapshotInvocation(boundaryIso:string):TaskctlInvocation{
  if(typeof boundaryIso!=="string"||!boundaryIso.trim())throw new Error("Management Review snapshot boundary is required");
  const instant=new Date(boundaryIso);if(Number.isNaN(instant.getTime()))throw new Error("Management Review snapshot boundary must be a valid ISO timestamp");
  const boundary=instant.toISOString();
  return{executable:TASKCTL_EXECUTABLE,argv:["review","management-snapshot"],options:{shell:false,env:{HOME:"/home/dubrovin",PATH:"/usr/bin:/bin",LANG:"C.UTF-8",TZ:"Europe/Moscow",TASKCTL_PAYLOAD:JSON.stringify({boundary})},stdio:["ignore","pipe","pipe"]}};
}
export async function runManagementReviewSnapshot(boundaryIso:string,options:RunOptions={}){return runInvocation(buildManagementReviewSnapshotInvocation(boundaryIso),{...options,outputLimitBytes:options.outputLimitBytes??2*1024*1024});}
export type ReminderInternalAction = "dispatch" | "render" | "settle";
export function buildReminderInternalInvocation(action:ReminderInternalAction,payload:JsonObject):TaskctlInvocation{
  const allowed=action==="dispatch"?["claim_token","boundary","limit"]:action==="render"?["claim_token"]:["claim_token","delivered"];
  if(!payload||Array.isArray(payload)||typeof payload!=="object")throw new Error("Reminder internal payload must be an object");
  const keys=Object.keys(payload);if(keys.some(key=>!allowed.includes(key)))throw new Error(`Reminder internal ${action} payload contains unsupported fields`);
  if(!validInternalString(payload.claim_token,500))throw new Error("Reminder internal claim_token is required");
  if(action==="dispatch"){const boundary=payload.boundary;if(typeof boundary!=="string"||!boundary.trim()||Number.isNaN(new Date(boundary).getTime()))throw new Error("Reminder internal boundary must be a valid ISO timestamp");if(payload.limit!==undefined&&(!Number.isSafeInteger(payload.limit)||Number(payload.limit)<1||Number(payload.limit)>100))throw new Error("Reminder internal limit must be 1..100");}
  if(action==="settle"&&typeof payload.delivered!=="boolean")throw new Error("Reminder internal delivered must be boolean");
  return{executable:TASKCTL_EXECUTABLE,argv:["reminder-internal",action],options:{shell:false,env:{HOME:"/home/dubrovin",PATH:"/usr/bin:/bin",LANG:"C.UTF-8",TZ:"Europe/Moscow",TASKCTL_PAYLOAD:JSON.stringify(payload)},stdio:["ignore","pipe","pipe"]}};
}
export async function runReminderInternal(action:ReminderInternalAction,payload:JsonObject,options:RunOptions={}){return runInvocation(buildReminderInternalInvocation(action,payload),options);}
