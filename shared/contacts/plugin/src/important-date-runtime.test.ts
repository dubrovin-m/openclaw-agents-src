import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./index.js",()=>({runImportantDateInternal:vi.fn()}));
import { runImportantDateInternal } from "./index.js";
import { importantDateProjectionPath } from "./important-date-projection.js";
import {
  CONTACT_DATE_REMINDER_DISPATCH_TOOL,IMPORTANT_DATE_DISPATCH_CRON,IMPORTANT_DATE_DISPATCH_DECLARATION,IMPORTANT_DATE_TIMEZONE,
  buildImportantDateDispatchScript,createImportantDateDispatchTool,executeImportantDateDispatch,registerImportantDateRuntime,
} from "./important-date-runtime.js";
const runInternal=vi.mocked(runImportantDateInternal);
type Hook=(...args:any[])=>any;
type RegisteredService={start:(context:any)=>Promise<void>|void;stop:()=>Promise<void>|void};
const tempDirs:string[]=[];
async function fixture(options:{startRun?:boolean}={}){
  const stateDir=await mkdtemp(join(tmpdir(),"important-date-runtime-"));tempDirs.push(stateDir);
  const runAtMs=Date.now();
  const job={id:"job-1",declarationKey:IMPORTANT_DATE_DISPATCH_DECLARATION,agentId:"main",enabled:true,
    schedule:{kind:"cron",expr:IMPORTANT_DATE_DISPATCH_CRON,tz:IMPORTANT_DATE_TIMEZONE,staggerMs:0},sessionTarget:"isolated",
    payload:{kind:"script",script:buildImportantDateDispatchScript(),toolsAllow:[CONTACT_DATE_REMINDER_DISPATCH_TOOL]},
    delivery:{mode:"announce",channel:"telegram",accountId:"default",to:"123",bestEffort:false}};
  const scheduler={list:vi.fn(async()=>[job])},hooks=new Map<string,Hook>();let registered:RegisteredService|undefined;
  const api={
    config:{commands:{ownerAllowFrom:["telegram:123"]},channels:{telegram:{enabled:true}},bindings:[{agentId:"main",match:{channel:"telegram",accountId:"default"}}]},
    on:(name:string,handler:Hook)=>hooks.set(name,handler),registerService:(service:RegisteredService)=>{registered=service;},
  };
  registerImportantDateRuntime(api as never);
  expect(registered).toBeDefined();
  await registered!.start({stateDir,getCron:()=>scheduler});
  if(options.startRun!==false)await hooks.get("cron_changed")?.({action:"started",jobId:job.id,runAtMs});
  return{stateDir,path:importantDateProjectionPath(stateDir),runAtMs,job,scheduler,hooks,registered};
}
beforeEach(()=>{runInternal.mockReset();});
afterEach(async()=>{await Promise.all(tempDirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
describe("Important Dates scheduler runtime",()=>{
  it("builds one bounded scheduler script",()=>{
    expect(buildImportantDateDispatchScript()).toBe([
      "const dispatch = await contact_date_reminder_dispatch({});",
      "json(dispatch.count > 0 ? { notify: dispatch.message } : {});",
    ].join("\n"));
  });
  it("bridges the gateway scheduler into an isolated cron tool through durable projection",async()=>{
    const{path,runAtMs}=await fixture();
    expect(createImportantDateDispatchTool({agentId:"main",sessionKey:"agent:main:main"} as never)).toBeNull();
    expect(createImportantDateDispatchTool({agentId:"tasks",sessionKey:"agent:tasks:cron:job-1:trigger"} as never)).toBeNull();
    expect(createImportantDateDispatchTool({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never)).not.toBeNull();
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"Важные даты"} as never);
    await expect(executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never,{path,nowMs:runAtMs})).resolves.toMatchObject({count:1});
    expect(runInternal).toHaveBeenCalledWith("date_dispatch",{claim_token:`important-date:job-1:${runAtMs}`,boundary:new Date(runAtMs).toISOString()},{signal:undefined});
  });
  it("does not depend on cron_changed started observation completing before isolated tool execution",async()=>{
    const{path,runAtMs,hooks}=await fixture({startRun:false});
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"Важные даты"} as never);
    const pending=executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never,{path,nowMs:runAtMs,waitMs:500,pollMs:5});
    await new Promise(resolve=>setTimeout(resolve,30));
    await hooks.get("cron_changed")?.({action:"started",jobId:"job-1",runAtMs});
    await expect(pending).resolves.toMatchObject({count:1});
  });
  it("fails closed when the durable projection is stale or tampered",async()=>{
    const{path,runAtMs}=await fixture();
    await expect(executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never,{path,nowMs:runAtMs+6*60*1000,waitMs:0})).rejects.toThrow("stale");
    const projection=JSON.parse(await readFile(path,"utf8"));projection.job.delivery.to="999";
    await writeFile(path,`${JSON.stringify(projection,null,2)}\n`);
    await expect(executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never,{path,nowMs:runAtMs,waitMs:0})).rejects.toThrow("delivery route drift");
    expect(runInternal).not.toHaveBeenCalled();
  });
  it("re-renders immediately before send and settles only the matching native run",async()=>{
    const{path,runAtMs,hooks}=await fixture();
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"stale"} as never);
    await executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never,{path,nowMs:runAtMs});
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"fresh"} as never);
    const result=await hooks.get("reply_payload_sending")?.({payload:{text:"stale"},sessionKey:"agent:main:cron:job-1:trigger"},{channelId:"telegram",accountId:"default",sessionKey:"agent:main:cron:job-1:trigger"});
    expect(result).toEqual({payload:{text:"fresh"}});
    expect(runInternal).toHaveBeenLastCalledWith("date_render",{claim_token:`important-date:job-1:${runAtMs}`});
    runInternal.mockResolvedValueOnce({ok:true,count:1,delivered:true} as never);
    await hooks.get("cron_changed")?.({action:"finished",jobId:"job-1",runAtMs,completionStatus:"succeeded",delivered:true,deliveryStatus:"delivered"});
    expect(runInternal).toHaveBeenLastCalledWith("date_settle",{claim_token:`important-date:job-1:${runAtMs}`,delivered:true});
    const calls=runInternal.mock.calls.length;
    await hooks.get("cron_changed")?.({action:"finished",jobId:"job-1",runAtMs:runAtMs-1,completionStatus:"succeeded",delivered:true,deliveryStatus:"delivered"});
    expect(runInternal.mock.calls).toHaveLength(calls);
  });
  it("cancels outbound send when the claimed date/reminder was removed",async()=>{
    const{path,runAtMs,hooks}=await fixture();
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"stale"} as never);
    await executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never,{path,nowMs:runAtMs});
    runInternal.mockResolvedValueOnce({ok:true,count:0,message:""} as never);
    const result=await hooks.get("reply_payload_sending")?.({payload:{text:"stale"},sessionKey:"agent:main:cron:job-1:trigger"},{channelId:"telegram",accountId:"default",sessionKey:"agent:main:cron:job-1:trigger"});
    expect(result).toEqual({cancel:true,reason:"important_date_claim_no_longer_active"});
  });
  it("uses cron_changed config events only as hints to reread authoritative scheduler state",async()=>{
    const{path,job,hooks}=await fixture();job.delivery.to="999";
    await hooks.get("cron_changed")?.({action:"updated",jobId:"job-1"});
    await expect(readFile(path,"utf8")).rejects.toMatchObject({code:"ENOENT"});
  });
});
