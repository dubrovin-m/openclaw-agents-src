import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type TSchema } from "typebox";
import { ACTIONS, executeContactctl, type ContactAction } from "./index.js";

const personId=Type.String({pattern:"^P-[1-9]\\d*$"});
const operationKey=Type.String({minLength:1,maxLength:500});
const shortText=Type.String({minLength:1,maxLength:500});
const nullableText=Type.Union([shortText,Type.Null()]);

export const CONTACT_SCHEMAS:Record<ContactAction,TSchema>={
  contact_search:Type.Object({query:shortText,organization:Type.Optional(shortText),title:Type.Optional(shortText),limit:Type.Optional(Type.Integer({minimum:1,maximum:200}))},{additionalProperties:false}),
  contact_resolve:Type.Object({reference:shortText,organization:Type.Optional(shortText),title:Type.Optional(shortText)},{additionalProperties:false}),
  contact_get:Type.Object({id:personId},{additionalProperties:false}),
  contact_create:Type.Object({operation_key:operationKey,display_name:shortText,organization:Type.Optional(shortText),title:Type.Optional(shortText)},{additionalProperties:false}),
  contact_update:Type.Object({operation_key:operationKey,id:personId,display_name:Type.Optional(shortText),organization:Type.Optional(nullableText),title:Type.Optional(nullableText)},{additionalProperties:false,minProperties:3}),
  contact_rename:Type.Object({operation_key:operationKey,id:personId,display_name:shortText},{additionalProperties:false}),
  contact_alias_add:Type.Object({operation_key:operationKey,id:personId,alias:shortText},{additionalProperties:false}),
  contact_alias_remove:Type.Object({operation_key:operationKey,id:personId,alias:shortText},{additionalProperties:false}),
  contact_merge:Type.Object({operation_key:operationKey,from_id:personId,into_id:personId},{additionalProperties:false}),
};
const meta:Record<ContactAction,{label:string;description:string}>={
  contact_search:{label:"Contact search",description:"Search shared canonical Person identities by name, alias, organization, or title."},
  contact_resolve:{label:"Contact resolve",description:"Resolve a Person reference deterministically to MATCH, AMBIGUOUS, or NOT_FOUND."},
  contact_get:{label:"Contact inspect",description:"Inspect one stable P-* identity, including historical merge redirect when present."},
  contact_create:{label:"Contact create",description:"Create one explicit durable Person identity after user-authorized creation."},
  contact_update:{label:"Contact update",description:"Update bounded identifying facts for an existing canonical Person."},
  contact_rename:{label:"Contact rename",description:"Rename an existing canonical Person while preserving the prior useful name as an alias."},
  contact_alias_add:{label:"Contact alias add",description:"Add a persisted Person alias. Alias ambiguity is allowed and must be surfaced on resolution."},
  contact_alias_remove:{label:"Contact alias remove",description:"Remove one persisted alias from a canonical Person."},
  contact_merge:{label:"Contact merge",description:"Confirm that two P-* identities represent one Person; preserve the source as a MERGED historical redirect."},
};

const entry=defineToolPlugin({
  id:"contacts",name:"Contacts",description:"Bounded shared Person identity operations.",
  tools:(tool)=>(Object.keys(ACTIONS) as ContactAction[]).map(action=>tool({
    name:action,
    label:meta[action].label,
    description:meta[action].description,
    parameters:CONTACT_SCHEMAS[action],
    factory:()=>({
      name:action,
      label:meta[action].label,
      description:meta[action].description,
      parameters:CONTACT_SCHEMAS[action],
      catalogMode:"direct-only",
      execute:async(_toolCallId,params,signal)=>jsonResult(await executeContactctl(action,params as Record<string,unknown>,{signal})),
    }),
  })),
});
export default entry;
