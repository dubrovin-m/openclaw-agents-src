import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { ACTIONS } from "./index.js";
import entry, { CONTACT_SCHEMAS } from "./plugin.js";

const actions=Object.keys(ACTIONS) as Array<keyof typeof ACTIONS>;

describe("Contacts bounded tool surface",()=>{
  it("exposes only the explicit Contact Registry actions",()=>{
    const names=(getToolPluginMetadata(entry)?.tools??[]).map(t=>t.name);
    expect(names).toEqual(actions);
    expect(names).not.toContain("contacts");
    expect(new Set(names).size).toBe(actions.length);
  });
  it("keeps every Contact tool default-admitted and direct-visible in the Codex harness",()=>{
    const runtimeTools:Array<Record<string,unknown>>=[];
    const registrations:Array<Record<string,unknown>|undefined>=[];
    (entry as any).register({
      pluginConfig:{},
      registerTool:(definition:unknown,options?:Record<string,unknown>)=>{
        registrations.push(options);
        const resolved=typeof definition==="function"?(definition as (ctx:unknown)=>unknown)({}):definition;
        if(Array.isArray(resolved)) runtimeTools.push(...resolved as Array<Record<string,unknown>>);
        else if(resolved) runtimeTools.push(resolved as Record<string,unknown>);
      },
    });
    expect(runtimeTools.map(tool=>tool.name)).toEqual(actions);
    expect(registrations.every(options=>options?.optional!==true)).toBe(true);
    expect(runtimeTools.every(tool=>tool.catalogMode==="direct-only")).toBe(true);
  });
  it("keeps the manifest aligned and default-admitted",()=>{
    const manifest=JSON.parse(readFileSync(new URL("../openclaw.plugin.json",import.meta.url),"utf8"));
    expect(manifest.contracts.tools).toEqual(actions);
    expect(Object.values(manifest.toolMetadata??{}).some((value:any)=>value?.optional===true)).toBe(false);
  });
  it("rejects cross-entity ids and extra fields at the schema boundary",()=>{
    expect(Value.Check(CONTACT_SCHEMAS.contact_get,{id:"P-1"})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_get,{id:"T-1"})).toBe(false);
    expect(Value.Check(CONTACT_SCHEMAS.contact_get,{id:"P-1",sql:"select 1"})).toBe(false);
    expect(Value.Check(CONTACT_SCHEMAS.contact_create,{operation_key:"x",display_name:"Иванов И."})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_create,{operation_key:"x",display_name:"Иванов И.",is_self:true})).toBe(false);
  });
  it("requires a real Contact fact change for update",()=>{
    expect(Value.Check(CONTACT_SCHEMAS.contact_update,{operation_key:"x",id:"P-2",title:"CEO"})).toBe(true);
    expect(Value.Check(CONTACT_SCHEMAS.contact_update,{operation_key:"x",id:"P-2"})).toBe(false);
  });
});
