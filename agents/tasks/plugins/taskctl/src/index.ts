import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ACTION_REGISTRY, getActionDefinition, type TaskctlAction } from "./contract.js";

export { ACTION_REGISTRY, TASKCTL_ACTIONS, type TaskctlAction } from "./contract.js";

export const TASKCTL_EXECUTABLE = "/home/dubrovin/.local/bin/taskctl";
export const TASKCTL_TIMEOUT_MS = 10_000;
export const TASKCTL_OUTPUT_LIMIT_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

function validationError(message:string, details:JsonObject={}) { return { ok:false, error:{ code:"TASKCTL_VALIDATION_ERROR", message, ...details } }; }
const has=(o:JsonObject,k:string)=>Object.hasOwn(o,k);
const validString=(v:unknown,max:number,nullable=false)=>v===null?nullable:typeof v==="string"&&v.trim().length>0&&v.trim().length<=max;
const validId=(v:unknown,prefix:string)=>Number.isSafeInteger(v)&&Number(v)>0||typeof v==="string"&&new RegExp("^(?:"+prefix+"-)?[1-9]\\d*$","i").test(v.trim());
const validProjectId=(v:unknown)=>typeof v==="string"&&/^PRJ-[1-9]\d*$/i.test(v.trim());
const validCanonicalId=(v:unknown,prefix:string)=>typeof v==="string"&&new RegExp("^"+prefix+"-[1-9]\\d*$","i").test(v.trim());
const validRecurrenceRule=(v:unknown)=>{if(!v||Array.isArray(v)||typeof v!=="object")return false;const x=v as JsonObject;if(x.kind==="DAYS")return Object.keys(x).every(k=>["kind","interval","start_date"].includes(k))&&Number.isSafeInteger(x.interval)&&Number(x.interval)>0&&validDate(x.start_date,false);if(x.kind==="WEEKS")return Object.keys(x).every(k=>["kind","interval","weekdays","start_date"].includes(k))&&Number.isSafeInteger(x.interval)&&Number(x.interval)>0&&Array.isArray(x.weekdays)&&x.weekdays.length>0&&x.weekdays.length<=7&&x.weekdays.every(d=>Number.isSafeInteger(d)&&Number(d)>=1&&Number(d)<=7)&&validDate(x.start_date,false);if(x.kind==="MONTHS")return Object.keys(x).every(k=>["kind","interval","day","start_date"].includes(k))&&Number.isSafeInteger(x.interval)&&Number(x.interval)>0&&Number.isSafeInteger(x.day)&&Number(x.day)>=1&&Number(x.day)<=28&&validDate(x.start_date,false);if(x.kind==="YEARLY")return Object.keys(x).every(k=>["kind","month","day","start_date"].includes(k))&&Number.isSafeInteger(x.month)&&Number(x.month)>=1&&Number(x.month)<=12&&Number.isSafeInteger(x.day)&&Number(x.day)>=1&&Number(x.day)<=31&&validDate(x.start_date,false);return Object.keys(x).every(k=>["interval","unit"].includes(k))&&Number.isSafeInteger(x.interval)&&Number(x.interval)>0&&["DAYS","WEEKS","MONTHS"].includes(String(x.unit));};
const validDate=(v:unknown,nullable=true)=>{if(v===null)return nullable;if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(v+"T00:00:00Z");return!Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;};
const validTime=(v:unknown)=>v===null||typeof v==="string"&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
const validEmoji=(v:unknown)=>v===null||typeof v==="string"&&v.trim().length>0&&v.trim().length<=32&&!/[\r\n]/.test(v);
const validLabelSpec=(v:unknown)=>{if(validString(v,500))return true;if(v===null||typeof v!=="object"||Array.isArray(v))return false;const x=v as JsonObject,keys=Object.keys(x);if(keys.some(k=>!["id","name","create"].includes(k)))return false;const refs=["id","name"].filter(k=>has(x,k));if(refs.length!==1)return false;if(has(x,"id")&&!validId(x.id,"L"))return false;if(has(x,"name")&&!validString(x.name,500))return false;if(has(x,"create")&&(typeof x.create!=="boolean"||!has(x,"name")))return false;return true;};
const validNewTask=(v:unknown)=>{if(v===null||typeof v!=="object"||Array.isArray(v))return false;const x=v as JsonObject,allowed=["title","assignee","create_assignee","status","due_date","due_time","labels","project_id"];if(Object.keys(x).some(k=>!allowed.includes(k))||!validString(x.title,2000)||!validString(x.assignee,500))return false;if(has(x,"create_assignee")&&typeof x.create_assignee!=="boolean")return false;if(has(x,"status")&&!["OPEN","DONE"].includes(String(x.status)))return false;if(has(x,"due_date")&&!validDate(x.due_date)||has(x,"due_time")&&!validTime(x.due_time))return false;if(x.due_time!==undefined&&x.due_time!==null&&(!has(x,"due_date")||x.due_date===null))return false;if(has(x,"labels")&&(!Array.isArray(x.labels)||x.labels.length>20||!x.labels.every(validLabelSpec)))return false;if(has(x,"project_id")&&!validProjectId(x.project_id))return false;return true;};
function valueError(action:TaskctlAction,key:string,value:unknown):string|null {
  const stringLimits:Record<string,number>={operation_key:500,capture_key:500,content:20000,title:2000,text:2000,assignee:500,search:1000,display_name:500,reference:500,alias:500,expansion:2000,label:500};
  if(Object.hasOwn(stringLimits,key)&&!validString(value,stringLimits[key]))return key+" must be a non-empty bounded string";
  if(key==="reason"&&!validString(value,2000,true))return"reason must be a non-empty string or null";
  if(key==="emoji"&&!validEmoji(value))return"emoji must be a non-empty presentation string up to 32 characters or null";
  if(["create_assignee","create_label"].includes(key)&&typeof value!=="boolean")return key+" must be boolean";
  if(key==="id"){if(action.startsWith("reminder_")){if(!validCanonicalId(value,"REM"))return"id must be a canonical REM-* identifier";}else if(action.startsWith("recurrence_")){if(!validCanonicalId(value,"R"))return"id must be a canonical R-* identifier";}else if(action.startsWith("project_")){if(!validProjectId(value))return"id must be a canonical PRJ-* identifier";}else{const prefix=action.startsWith("inbox_")?"I":action.startsWith("task_")?"T":action.startsWith("person_")?"P":action.startsWith("label_")?"L":"";if(!prefix||!validId(value,prefix))return"id has the wrong entity type";}}
  if(key==="task_id"&&action==="reminder_create"&&!validCanonicalId(value,"T"))return"task_id must be a canonical T-* identifier";
  if(key==="task_id"&&action!=="reminder_create"&&!validId(value,"T"))return"task_id must be a T-* id or positive integer";
  if(key==="assignee_id"&&action.startsWith("recurrence_")&&!validCanonicalId(value,"P"))return"assignee_id must be a canonical P-* id";
  if(key==="assignee_id"&&!action.startsWith("recurrence_")&&!validId(value,"P"))return"assignee_id must be a P-* id or positive integer";
  if(key==="label_id"&&!validId(value,"L"))return"label_id must be an L-* id or positive integer";
  if(key==="project_id"){if(action==="task_project_set"){if(value!==null&&!validProjectId(value))return"project_id must be a canonical PRJ-* identifier or null";}else if(!validProjectId(value))return"project_id must be a canonical PRJ-* identifier";}
  if(["from_id","into_id"].includes(key)){const prefix=action.startsWith("person_")?"P":"L";if(!validId(value,prefix))return key+" has the wrong entity type";}
  if(key==="due_date"&&!validDate(value)||["due_on","due_until"].includes(key)&&!validDate(value,false))return key+" must be a real YYYY-MM-DD date";
  if(key==="due_time"&&!validTime(value))return"due_time must be HH:MM or null";
  if(key==="status"){
    const allowed=action==="task_create"?["OPEN","DONE"]:action==="project_list"?["ACTIVE","DONE","CANCELLED","*"]:action==="recurrence_list"?["ACTIVE","PAUSED","CANCELLED","*"]:["OPEN","DONE","CANCELLED","*"];
    if(!allowed.includes(String(value)))return"status is invalid for "+action;
  }
  if(key==="view"&&!["today","overdue","no_due"].includes(String(value)))return"view is invalid";
  if(key==="context"&&!["task","inbox","auto"].includes(String(value)))return"context is invalid";
  if(key==="limit"&&(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>200))return"limit must be an integer from 1 to 200";
  if(key==="number"&&(!Number.isSafeInteger(value)||Number(value)<1))return"number must be a positive integer";
  if(key==="mode"&&!['CALENDAR','AFTER_COMPLETION'].includes(String(value)))return"mode must be CALENDAR or AFTER_COMPLETION";
  if(key==="rule"&&!validRecurrenceRule(value))return"rule is invalid";
  if(key==="seed_task_id"&&!validCanonicalId(value,"T"))return"seed_task_id must be a canonical T-* id";
  if(key==="label_ids"&&(!Array.isArray(value)||value.length>20||!value.every(v=>validCanonicalId(v,"L"))))return"label_ids must contain canonical L-* ids";
  if(key==="target_project_id"&&value!==null&&!validProjectId(value))return"target_project_id must be a canonical PRJ-* id or null";
  if(["first_due_date","cycle_anchor_date","trigger_date"].includes(key)&&!validDate(value,false))return key+" must be a real YYYY-MM-DD date";
  if(key==="trigger_time"&&(typeof value!=="string"||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)))return"trigger_time must be HH:MM";
  if(key==="tasks"&&(!Array.isArray(value)||value.length<1||value.length>20||!value.every(validNewTask)))return"tasks contains an invalid task specification";
  if(key==="labels"&&(!Array.isArray(value)||value.length>20||!value.every(validLabelSpec)))return"labels contains an invalid label specification";
  return null;
}
export function validateAndSanitizePayload(action: unknown, payload: unknown): {ok:true;action:TaskctlAction;payload:JsonObject}|{ok:false;error:ReturnType<typeof validationError>} {
  if(typeof action!=="string" || !Object.hasOwn(ACTION_REGISTRY,action)) return {ok:false,error:validationError("Unknown taskctl action")};
  if(payload===null||typeof payload!=="object"||Array.isArray(payload)) return {ok:false,error:validationError("payload must be an object")};
  const a=action as TaskctlAction,rule=getActionDefinition(a),obj=payload as JsonObject,keys=Object.keys(obj);
  const extra=keys.filter(k=>!rule.allowed.includes(k));if(extra.length)return{ok:false,error:validationError("payload contains fields not allowed for "+a,{fields:extra})};
  const missing=(rule.required??[]).filter(k=>!has(obj,k));if(missing.length)return{ok:false,error:validationError("payload is missing required fields for "+a,{fields:missing})};
  for(const group of rule.exactlyOneOf??[]){const present=group.filter(k=>has(obj,k));if(present.length!==1)return{ok:false,error:validationError("payload must include exactly one of "+group.join(", ")+" for "+a)};}
  for(const group of [["assignee","assignee_id"],["label","label_id"]])if(group.every(k=>has(obj,k)))return{ok:false,error:validationError("payload contains mutually exclusive fields for "+a,{fields:group})};
  for(const key of keys){const message=valueError(a,key,obj[key]);if(message)return{ok:false,error:validationError(message,{field:key})};}
  if(a==="task_update"&&keys.every(k=>["operation_key","id","reason"].includes(k)))return{ok:false,error:validationError("task_update requires at least one mutable task field")};
  if(a==="task_update"&&has(obj,"reason")&&!has(obj,"due_date")&&!has(obj,"due_time"))return{ok:false,error:validationError("reason is allowed only with a deadline change")};
  if(a==="deadline_request_create"&&!has(obj,"due_date")&&!has(obj,"due_time"))return{ok:false,error:validationError("deadline_request_create requires due_date and/or due_time")};
  if(a==="deadline_request_create"&&!validString(obj.reason,2000))return{ok:false,error:validationError("deadline_request_create requires a non-empty reason")};
  if(a==="task_create"&&obj.due_time!==undefined&&obj.due_time!==null&&(!has(obj,"due_date")||obj.due_date===null))return{ok:false,error:validationError("due_time requires due_date")};
  if(a==="recurrence_create"){
    const seeded=has(obj,"seed_task_id");
    if(seeded&&["title","assignee_id","label_ids","target_project_id","due_time","first_due_date"].some(k=>has(obj,k)))return{ok:false,error:validationError("seed Recurrence derives its template from the existing Task")};
    if(!seeded&&(!has(obj,"title")||!has(obj,"assignee_id")))return{ok:false,error:validationError("non-seed Recurrence requires title and assignee_id")};
    const recurrenceRuleObject=obj.rule as JsonObject;
    const calendarShaped=typeof recurrenceRuleObject?.kind==="string";
    if(obj.mode==="CALENDAR"&&!calendarShaped)return{ok:false,error:validationError("CALENDAR Recurrence requires a CALENDAR rule")};
    if(obj.mode==="AFTER_COMPLETION"&&calendarShaped)return{ok:false,error:validationError("AFTER_COMPLETION Recurrence requires an interval/unit rule")};
    if(obj.mode==="CALENDAR"&&has(obj,"first_due_date"))return{ok:false,error:validationError("CALENDAR Recurrence does not accept first_due_date")};
    if(obj.mode==="AFTER_COMPLETION"&&!seeded&&!has(obj,"first_due_date"))return{ok:false,error:validationError("AFTER_COMPLETION Recurrence requires first_due_date without a seed")};
  }
  if(a==="recurrence_update"&&keys.every(k=>["operation_key","id"].includes(k)))return{ok:false,error:validationError("recurrence_update requires at least one mutable field")};
  if(a==="recurrence_update"&&has(obj,"cycle_anchor_date")&&keys.some(k=>!["operation_key","id","cycle_anchor_date"].includes(k)))return{ok:false,error:validationError("cycle_anchor_date must be a standalone recurrence update")};
  if(has(obj,"create_assignee")&&!has(obj,"assignee"))return{ok:false,error:validationError("create_assignee requires assignee")};
  if(has(obj,"create_label")&&!has(obj,"label"))return{ok:false,error:validationError("create_label requires label")};
  return{ok:true,action:a,payload:Object.fromEntries(keys.map(k=>[k,obj[k]]))};
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
  if(!validString(payload.claim_token,500))throw new Error("Reminder internal claim_token is required");
  if(action==="dispatch"){const boundary=payload.boundary;if(typeof boundary!=="string"||!boundary.trim()||Number.isNaN(new Date(boundary).getTime()))throw new Error("Reminder internal boundary must be a valid ISO timestamp");if(payload.limit!==undefined&&(!Number.isSafeInteger(payload.limit)||Number(payload.limit)<1||Number(payload.limit)>100))throw new Error("Reminder internal limit must be 1..100");}
  if(action==="settle"&&typeof payload.delivered!=="boolean")throw new Error("Reminder internal delivered must be boolean");
  return{executable:TASKCTL_EXECUTABLE,argv:["reminder-internal",action],options:{shell:false,env:{HOME:"/home/dubrovin",PATH:"/usr/bin:/bin",LANG:"C.UTF-8",TZ:"Europe/Moscow",TASKCTL_PAYLOAD:JSON.stringify(payload)},stdio:["ignore","pipe","pipe"]}};
}
export async function runReminderInternal(action:ReminderInternalAction,payload:JsonObject,options:RunOptions={}){return runInvocation(buildReminderInternalInvocation(action,payload),options);}
