import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { runImportantDateInternal } from "./index.js";
import {
  beginImportantDateProjectedRun,
  finishImportantDateProjectedRun,
  importantDateProjectionPath,
  readImportantDateProjection,
  reconcileImportantDateProjection,
  removeImportantDateProjection,
  type ImportantDateProjectedJob,
  type ImportantDateProjection,
} from "./important-date-projection.js";

export const CONTACT_DATE_REMINDER_DISPATCH_TOOL = "contact_date_reminder_dispatch";
export const IMPORTANT_DATE_DISPATCH_DECLARATION = "contacts.important-dates.dispatch.v1";
export const IMPORTANT_DATE_DISPATCH_NAME = "contacts-important-dates-dispatch";
export const IMPORTANT_DATE_DISPATCH_CRON = "0 9 * * *";
export const IMPORTANT_DATE_TIMEZONE = "Europe/Moscow";
const AGENT_ID = "main";
const ACCOUNT_ID = "default";
const CHANNEL_ID = "telegram";
const ACTIVE_RUN_MAX_AGE_MS = 5 * 60 * 1000;
const ACTIVE_RUN_FUTURE_TOLERANCE_MS = 30 * 1000;

export const importantDateDispatchParameters = Type.Object({}, { additionalProperties: false });

type SchedulerJob = {
  id: string;
  declarationKey?: string;
  agentId?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string; staggerMs?: number };
  sessionTarget?: string;
  payload?: { kind?: string; script?: string; toolsAllow?: string[] };
  delivery?: { mode?: string; channel?: string; accountId?: string; to?: string; bestEffort?: boolean };
  state?: { runningAtMs?: number };
};
type SchedulerService = { list: (opts?: { includeDisabled?: boolean }) => Promise<SchedulerJob[]> };
type JsonRecord = Record<string, unknown>;

function parseCurrentJobId(sessionKey: string | undefined, agentId?: string): string | null {
  if (agentId !== undefined && agentId !== AGENT_ID) return null;
  if (!sessionKey) return null;
  return /^agent:main:cron:([^:]+):trigger$/.exec(sessionKey)?.[1] ?? null;
}
function claimToken(jobId:string,runAtMs:number):string {
  if(!jobId.trim()||!Number.isFinite(runAtMs))throw new Error("Important Dates run identity is invalid");
  return `important-date:${jobId}:${Math.trunc(runAtMs)}`;
}
function requireObject(value:unknown,label:string):JsonRecord {
  if(!value||Array.isArray(value)||typeof value!=="object")throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}
function requireSuccessful(value:unknown,label:string):JsonRecord {
  const record=requireObject(value,label);
  if(record.ok!==true){
    const error=record.error&&typeof record.error==="object"&&!Array.isArray(record.error)?record.error as JsonRecord:null;
    throw new Error(`${label} failed: ${typeof error?.message==="string"?error.message:"unknown error"}`);
  }
  return record;
}
function resolveExpectedRecipient(config:unknown):string {
  const root=config&&typeof config==="object"&&!Array.isArray(config)?config as JsonRecord:null;
  const commands=root?.commands&&typeof root.commands==="object"&&!Array.isArray(root.commands)?root.commands as JsonRecord:null;
  const allow=commands?.ownerAllowFrom;
  if(!Array.isArray(allow)||allow.length!==1)throw new Error("Important Dates delivery requires exactly one ownerAllowFrom entry");
  const ownerRoute=String(allow[0]??"").trim();
  const match=/^telegram:([1-9]\d*)$/.exec(ownerRoute);
  if(!match)throw new Error("Important Dates owner route must be one telegram:<id> target");
  const recipient=match[1]!;
  const channels=root?.channels&&typeof root.channels==="object"&&!Array.isArray(root.channels)?root.channels as JsonRecord:null;
  const telegram=channels?.telegram&&typeof channels.telegram==="object"&&!Array.isArray(channels.telegram)?channels.telegram as JsonRecord:null;
  if(telegram?.enabled!==true)throw new Error("Telegram must be enabled for Important Dates delivery");
  const bindings=Array.isArray(root?.bindings)?root.bindings as JsonRecord[]:[];
  const matches=bindings.filter((x)=>{
    const match=x?.match&&typeof x.match==="object"&&!Array.isArray(x.match)?x.match as JsonRecord:null;
    return x?.agentId===AGENT_ID&&match?.channel===CHANNEL_ID&&match?.accountId===ACCOUNT_ID;
  });
  if(matches.length!==1)throw new Error("Important Dates delivery requires exactly one main/default Telegram binding");
  return recipient;
}
function validateJob(job:SchedulerJob,expectedRecipient:string):SchedulerJob {
  if(job.declarationKey!==IMPORTANT_DATE_DISPATCH_DECLARATION)throw new Error("Important Dates dispatcher identity mismatch");
  if(job.enabled!==true||job.agentId!==AGENT_ID||job.sessionTarget!=="isolated")throw new Error("Important Dates dispatcher must run as enabled isolated main agent");
  if(job.schedule?.kind!=="cron"||job.schedule.expr!==IMPORTANT_DATE_DISPATCH_CRON||job.schedule.tz!==IMPORTANT_DATE_TIMEZONE||(job.schedule.staggerMs!==undefined&&job.schedule.staggerMs!==0))throw new Error("Important Dates dispatcher schedule drift detected");
  if(job.payload?.kind!=="script"||job.payload.script!==buildImportantDateDispatchScript()||JSON.stringify(job.payload.toolsAllow??[])!==JSON.stringify([CONTACT_DATE_REMINDER_DISPATCH_TOOL]))throw new Error("Important Dates dispatcher payload drift detected");
  if(job.delivery?.mode!=="announce"||job.delivery.channel!==CHANNEL_ID||job.delivery.accountId!==ACCOUNT_ID||job.delivery.to!==expectedRecipient||(job.delivery.bestEffort!==undefined&&job.delivery.bestEffort!==false))throw new Error("Important Dates dispatcher delivery route drift detected");
  return job;
}
async function findRegisteredJob(service:SchedulerService,expectedRecipient:string):Promise<SchedulerJob> {
  const jobs=await service.list({includeDisabled:true});
  const matches=jobs.filter(job=>job.declarationKey===IMPORTANT_DATE_DISPATCH_DECLARATION);
  if(matches.length!==1)throw new Error(`Important Dates requires exactly one registered dispatcher; found ${matches.length}`);
  return validateJob(matches[0]!,expectedRecipient);
}
function projectJob(job:SchedulerJob):ImportantDateProjectedJob {
  return {
    id:job.id,
    declarationKey:job.declarationKey!,
    agentId:job.agentId!,
    enabled:job.enabled!,
    schedule:{kind:job.schedule!.kind!,expr:job.schedule!.expr!,tz:job.schedule!.tz!,...(job.schedule!.staggerMs===undefined?{}:{staggerMs:job.schedule!.staggerMs})},
    sessionTarget:job.sessionTarget!,
    payload:{kind:job.payload!.kind!,script:job.payload!.script!,toolsAllow:[...(job.payload!.toolsAllow??[])]},
    delivery:{mode:job.delivery!.mode!,channel:job.delivery!.channel!,accountId:job.delivery!.accountId!,to:job.delivery!.to!,...(job.delivery!.bestEffort===undefined?{}:{bestEffort:job.delivery!.bestEffort})},
  };
}
function validateActiveProjection(projection:ImportantDateProjection,jobId:string,nowMs:number):ImportantDateProjection {
  validateJob(projection.job,projection.expectedRecipient);
  if(projection.job.id!==jobId)throw new Error("Important Dates dispatcher identity mismatch");
  const active=projection.activeRun;
  if(!active)throw new Error("Important Dates scheduler projection has no active run");
  if(active.recordedAtMs>nowMs+ACTIVE_RUN_FUTURE_TOLERANCE_MS||nowMs-active.recordedAtMs>ACTIVE_RUN_MAX_AGE_MS)throw new Error("Important Dates scheduler projection is stale");
  if(active.runAtMs>nowMs+ACTIVE_RUN_FUTURE_TOLERANCE_MS||nowMs-active.runAtMs>ACTIVE_RUN_MAX_AGE_MS)throw new Error("Important Dates scheduler run boundary is stale");
  return projection;
}
async function requireActiveProjection(jobId:string,options:{path?:string;nowMs?:number}={}):Promise<ImportantDateProjection> {
  return validateActiveProjection(await readImportantDateProjection(options.path),jobId,options.nowMs??Date.now());
}
export function buildImportantDateDispatchScript():string {
  return [
    `const dispatch = await ${CONTACT_DATE_REMINDER_DISPATCH_TOOL}({});`,
    "json(dispatch.count > 0 ? { notify: dispatch.message } : {});",
  ].join("\n");
}
export async function executeImportantDateDispatch(toolContext:OpenClawPluginToolContext,deps:{signal?:AbortSignal;path?:string;nowMs?:number}={}):Promise<JsonRecord> {
  const jobId=parseCurrentJobId(toolContext.sessionKey,toolContext.agentId);
  if(!jobId)throw new Error(`${CONTACT_DATE_REMINDER_DISPATCH_TOOL} is available only to a main cron session`);
  const projection=await requireActiveProjection(jobId,{path:deps.path,nowMs:deps.nowMs});
  const runAtMs=projection.activeRun!.runAtMs,token=claimToken(jobId,runAtMs);
  const result=requireSuccessful(await runImportantDateInternal("date_dispatch",{claim_token:token,boundary:new Date(runAtMs).toISOString()},{signal:deps.signal}),"Important Dates dispatch");
  if(!Number.isSafeInteger(result.count)||Number(result.count)<0||typeof result.message!=="string")throw new Error("Important Dates dispatch returned an invalid result");
  return result;
}
export function createImportantDateDispatchTool(toolContext:OpenClawPluginToolContext):AnyAgentTool|null {
  if(!parseCurrentJobId(toolContext.sessionKey,toolContext.agentId))return null;
  return {
    name:CONTACT_DATE_REMINDER_DISPATCH_TOOL,
    label:"Important Dates Reminder Dispatcher",
    description:"Claim due ImportantDate reminders only inside the registered Contacts Automation run.",
    parameters:importantDateDispatchParameters,
    execute:async(_toolCallId,_params,signal)=>{
      const result=await executeImportantDateDispatch(toolContext,{signal});
      return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
    },
  };
}
async function handleReplyPayloadSending(event:{payload:JsonRecord;sessionKey?:string},context:{channelId:string;accountId?:string;sessionKey?:string},options:{path?:string;nowMs?:number}={}) {
  const jobId=parseCurrentJobId(event.sessionKey??context.sessionKey);
  if(!jobId)return undefined;
  try{
    const projection=await requireActiveProjection(jobId,options);
    if(context.channelId!==CHANNEL_ID||context.accountId!==ACCOUNT_ID)return{cancel:true,reason:"important_date_delivery_route_mismatch"};
    const token=claimToken(jobId,projection.activeRun!.runAtMs);
    const rendered=requireSuccessful(await runImportantDateInternal("date_render",{claim_token:token}),"Important Dates pre-send render");
    const count=Number(rendered.count),message=rendered.message;
    if(!Number.isSafeInteger(count)||count<0||typeof message!=="string")return{cancel:true,reason:"important_date_render_invalid"};
    if(count===0||!message.trim())return{cancel:true,reason:"important_date_claim_no_longer_active"};
    return{payload:{...event.payload,text:message}};
  }catch{return{cancel:true,reason:"important_date_pre_send_revalidation_failed"};}
}
async function handleCronChanged(event:{action:string;jobId:string;runAtMs?:number;completionStatus?:string;delivered?:boolean;deliveryStatus?:string},options:{path?:string;recordedAtMs?:number}={}) {
  const path=options.path;
  let projection:ImportantDateProjection;
  try{projection=await readImportantDateProjection(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  if(projection.job.id!==event.jobId)return;
  if(event.action==="updated"||event.action==="removed"){
    await removeImportantDateProjection(path);
    return;
  }
  if(event.action==="started"){
    if(typeof event.runAtMs!=="number"||!Number.isFinite(event.runAtMs))throw new Error("Important Dates dispatcher started without a run boundary");
    await beginImportantDateProjectedRun({path,jobId:event.jobId,runAtMs:event.runAtMs,recordedAtMs:options.recordedAtMs});
    return;
  }
  if(event.action!=="finished")return;
  if(typeof event.runAtMs!=="number"||!Number.isFinite(event.runAtMs))throw new Error("Important Dates dispatcher finished without a run boundary");
  if(projection.activeRun?.runAtMs!==event.runAtMs)return;
  const token=claimToken(event.jobId,event.runAtMs);
  const delivered=event.completionStatus==="succeeded"&&event.delivered===true&&event.deliveryStatus==="delivered";
  try{await runImportantDateInternal("date_settle",{claim_token:token,delivered});}
  finally{await finishImportantDateProjectedRun({path,jobId:event.jobId,runAtMs:event.runAtMs});}
}
export function registerImportantDateRuntime(api:OpenClawPluginApi):void {
  let statePath:string|undefined;
  const currentPath=()=>statePath??importantDateProjectionPath();
  const refresh=async(service:SchedulerService,path:string)=>{
    const expectedRecipient=resolveExpectedRecipient(api.config);
    const job=await findRegisteredJob(service,expectedRecipient);
    await reconcileImportantDateProjection({path,expectedRecipient,job:projectJob(job)});
  };
  api.registerService({
    id:"contacts-important-date-projection",
    start:async(context)=>{
      statePath=importantDateProjectionPath(context.stateDir);
      const service=context.getCron?.() as SchedulerService|undefined;
      if(!service)throw new Error("Important Dates projection initialization requires native Automation access");
      await refresh(service,statePath);
    },
    stop:()=>{statePath=undefined;},
  });
  api.on("cron_reconciled",async(event,context)=>{
    const path=currentPath();
    if(!event.enabled){await removeImportantDateProjection(path);return;}
    const service=context.getCron?.() as SchedulerService|undefined;
    if(!service){await removeImportantDateProjection(path);return;}
    try{await refresh(service,path);}catch{await removeImportantDateProjection(path);}
  });
  api.on("reply_payload_sending",(event,context)=>handleReplyPayloadSending(event as never,context,{path:currentPath()}));
  api.on("cron_changed",(event)=>handleCronChanged(event,{path:currentPath()}));
}
export const importantDateRuntimeInternals={
  parseCurrentJobId,claimToken,resolveExpectedRecipient,validateJob,findRegisteredJob,projectJob,validateActiveProjection,handleReplyPayloadSending,handleCronChanged,
};
