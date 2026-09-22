import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { ACTIONS } from "./index.js";
import { CONTACT_DATE_REMINDER_DISPATCH_TOOL } from "./important-date-runtime.js";
import entry, { CONTACT_SCHEMAS } from "./plugin.js";

const actions=Object.keys(ACTIONS) as Array<keyof typeof ACTIONS>;

describe("Contacts bounded tool surface",()=>{
  it("exposes public Contacts actions plus one scheduler-only dispatcher declaration",()=>{
    const metadata=getToolPluginMetadata(entry)?.tools??[];
    expect(metadata.map(t=>t.name)).toEqual([...actions,CONTACT_DATE_REMINDER_DISPATCH_TOOL]);
    expect(new Set(metadata.map(t=>t.name)).size).toBe(actions.length+1);
  });
  it("keeps public Contact tools default-admitted/direct-visible while the dispatcher is optional and absent from ordinary main",()=>{
    const runtimeTools:Array<Record<string,unknown>>=[];
    const registrations:Array<{name?:string;optional?:boolean}>=[];
    (entry as any).register({
      config:{},
      on:()=>{},
      registerTool:(definition:unknown,options?:Record<string,unknown>)=>{
        const resolved=typeof definition==="function"?(definition as (ctx:unknown)=>unknown)({toolContext:{agentId:"main",sessionKey:"agent:main:main"}}):definition;
        const items=Array.isArray(resolved)?resolved:[resolved];
        for(const item of items)if(item)runtimeTools.push(item as Record<string,unknown>);
        registrations.push({name:(items.find(Boolean) as any)?.name,optional:options?.optional as boolean|undefined});
      },
    });
    expect(runtimeTools.map(tool=>tool.name)).toEqual(actions);
    expect(runtimeTools.every(tool=>tool.catalogMode==="direct-only")).toBe(true);
    expect(runtimeTools.some(tool=>tool.name===CONTACT_DATE_REMINDER_DISPATCH_TOOL)).toBe(false);
  });
  it("keeps the manifest aligned with public plus scheduler-only tools",()=>{
    const manifest=JSON.parse(readFileSync(new URL("../openclaw.plugin.json",import.meta.url),"utf8"));
    expect(manifest.contracts.tools).toEqual([...actions,CONTACT_DATE_REMINDER_DISPATCH_TOOL]);
    expect(manifest.toolMetadata?.[CONTACT_DATE_REMINDER_DISPATCH_TOOL]?.optional).toBe(true);
    for(const action of actions)expect(manifest.toolMetadata?.[action]?.optional).not.toBe(true);
  });
  it("exposes bounded Person Group schemas",()=>{
    expect(Value.Check(CONTACT_SCHEMAS.contact_group_create,{operation_key:"g1",display_name:"Office CEO"})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_group_get,{id:"PG-1"})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_group_member_add,{operation_key:"gm1",group_id:"PG-1",person:"P-2"})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_group_member_add,{operation_key:"gm1",group_id:"P-1",person:"P-2"})).toBe(false);
  });

  it("requires an explicit reminder decision to create an ImportantDate",()=>{
    const base={operation_key:"x",person:"Иванов",type:"BIRTHDAY",month:10,day:17};
    expect(Value.Check(CONTACT_SCHEMAS.contact_date_create,{...base,reminders:[]})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_date_create,base)).toBe(false);
    expect(Value.Check(CONTACT_SCHEMAS.contact_date_create,{...base,reminders:[{offset_value:2,offset_unit:"MONTHS"}]})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_date_create,{...base,reminders:[{offset_value:121,offset_unit:"MONTHS"}]})).toBe(false);
    expect(Value.Check(CONTACT_SCHEMAS.contact_date_create,{...base,reminders:[{offset_value:521,offset_unit:"WEEKS"}]})).toBe(false);
  });
  it("rejects cross-entity ids and extra fields at the schema boundary",()=>{
    expect(Value.Check(CONTACT_SCHEMAS.contact_get,{id:"P-1"})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_get,{id:"T-1"})).toBe(false);
    expect(Value.Check(CONTACT_SCHEMAS.contact_date_update,{operation_key:"x",id:"DATE-1",day:2})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_date_update,{operation_key:"x",id:"P-1",day:2})).toBe(false);
    expect(Value.Check(CONTACT_SCHEMAS.contact_get,{id:"P-1",sql:"select 1"})).toBe(false);
  });
  it("requires a real Contact fact change for identity update",()=>{
    expect(Value.Check(CONTACT_SCHEMAS.contact_update,{operation_key:"x",id:"P-2",title:"CEO"})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_update,{operation_key:"x",id:"P-2"})).toBe(false);
  });
});
