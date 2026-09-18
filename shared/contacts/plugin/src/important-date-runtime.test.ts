import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./index.js",()=>({runImportantDateInternal:vi.fn()}));
import { runImportantDateInternal } from "./index.js";
import {
  CONTACT_DATE_REMINDER_DISPATCH_TOOL,IMPORTANT_DATE_DISPATCH_CRON,IMPORTANT_DATE_DISPATCH_DECLARATION,IMPORTANT_DATE_TIMEZONE,
  buildImportantDateDispatchScript,createImportantDateDispatchTool,executeImportantDateDispatch,importantDateRuntimeInternals,registerImportantDateRuntime,
} from "./important-date-runtime.js";
const runInternal=vi.mocked(runImportantDateInternal);
type Hook=(...args:any[])=>any;
function fixture(){
  const controller=new AbortController();
  const job={id:"job-1",declarationKey:IMPORTANT_DATE_DISPATCH_DECLARATION,agentId:"main",enabled:true,
    schedule:{kind:"cron",expr:IMPORTANT_DATE_DISPATCH_CRON,tz:IMPORTANT_DATE_TIMEZONE,staggerMs:0},sessionTarget:"isolated",
    payload:{kind:"script",script:buildImportantDateDispatchScript(),toolsAllow:[CONTACT_DATE_REMINDER_DISPATCH_TOOL]},
    delivery:{mode:"announce",channel:"telegram",accountId:"default",to:"123",bestEffort:false},
    state:{runningAtMs:Date.parse("2026-09-18T06:00:00.000Z")}};
  const service={list:vi.fn(async()=>[job])},hooks=new Map<string,Hook>();
  const api={config:{commands:{ownerAllowFrom:["telegram:123"]},channels:{telegram:{enabled:true}},bindings:[{agentId:"main",match:{channel:"telegram",accountId:"default"}}]},on:(name:string,handler:Hook)=>hooks.set(name,handler)};
  registerImportantDateRuntime(api as never);
  hooks.get("cron_reconciled")?.({enabled:true},{getCron:()=>service,abortSignal:controller.signal});
  return{job,service,hooks};
}
beforeEach(()=>{runInternal.mockReset();importantDateRuntimeInternals.resetState();});
describe("Important Dates scheduler runtime",()=>{
  it("builds one bounded scheduler script",()=>{
    expect(buildImportantDateDispatchScript()).toBe([
      "const dispatch = await contact_date_reminder_dispatch({});",
      "json(dispatch.count > 0 ? { notify: dispatch.message } : {});",
    ].join("\n"));
  });
  it("exposes dispatch only in the registered main cron session",async()=>{
    const{service}=fixture();
    expect(createImportantDateDispatchTool({agentId:"main",sessionKey:"agent:main:main"} as never)).toBeNull();
    expect(createImportantDateDispatchTool({agentId:"tasks",sessionKey:"agent:tasks:cron:job-1:trigger"} as never)).toBeNull();
    expect(createImportantDateDispatchTool({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never)).not.toBeNull();
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"Важные даты"} as never);
    await expect(executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never)).resolves.toMatchObject({count:1});
    expect(service.list).toHaveBeenCalled();
    expect(runInternal).toHaveBeenCalledWith("date_dispatch",{claim_token:"important-date:job-1:1789711200000",boundary:"2026-09-18T06:00:00.000Z"},{signal:undefined});
  });
  it("fails closed if owner route or persisted job drifts",async()=>{
    const{job}=fixture();job.delivery.to="999";
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"must not send"} as never);
    await expect(executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never)).rejects.toThrow("delivery route drift");
    expect(runInternal).not.toHaveBeenCalled();
  });
  it("re-renders immediately before send and settles only confirmed delivery",async()=>{
    const{hooks}=fixture();
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"stale"} as never);
    await executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never);
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"fresh"} as never);
    const result=await hooks.get("reply_payload_sending")?.({payload:{text:"stale"},sessionKey:"agent:main:cron:job-1:trigger"},{channelId:"telegram",accountId:"default",sessionKey:"agent:main:cron:job-1:trigger"});
    expect(result).toEqual({payload:{text:"fresh"}});
    expect(runInternal).toHaveBeenLastCalledWith("date_render",{claim_token:"important-date:job-1:1789711200000"});
    runInternal.mockResolvedValueOnce({ok:true,count:1,delivered:true} as never);
    await hooks.get("cron_changed")?.({action:"finished",jobId:"job-1",runAtMs:Date.parse("2026-09-18T06:00:00.000Z"),completionStatus:"succeeded",delivered:true,deliveryStatus:"delivered"});
    expect(runInternal).toHaveBeenLastCalledWith("date_settle",{claim_token:"important-date:job-1:1789711200000",delivered:true});
  });
  it("cancels outbound send when the claimed date/reminder was removed",async()=>{
    const{hooks}=fixture();
    runInternal.mockResolvedValueOnce({ok:true,count:1,message:"stale"} as never);
    await executeImportantDateDispatch({agentId:"main",sessionKey:"agent:main:cron:job-1:trigger"} as never);
    runInternal.mockResolvedValueOnce({ok:true,count:0,message:""} as never);
    const result=await hooks.get("reply_payload_sending")?.({payload:{text:"stale"},sessionKey:"agent:main:cron:job-1:trigger"},{channelId:"telegram",accountId:"default",sessionKey:"agent:main:cron:job-1:trigger"});
    expect(result).toEqual({cancel:true,reason:"important_date_claim_no_longer_active"});
  });
});
