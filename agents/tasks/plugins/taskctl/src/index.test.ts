import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_REGISTRY, TASKCTL_ACTIONS } from "./contract.js";
import { TASKCTL_EXECUTABLE, buildInvocation, executeTaskctl, validateAndSanitizePayload } from "./index.js";

const CANDIDATE_TASKCTL = join(process.cwd(), "..", "..", "taskctl");

const VALID_PAYLOADS: Record<string, Record<string, unknown>> = {
  deadline_request_get:{task_id:"T-1"}, deadline_request_create:{operation_key:"d1",task_id:"T-1",due_date:"2026-09-29",reason:"blocked"}, deadline_request_approve:{operation_key:"d2",task_id:"T-1",due_date:"2026-09-26"}, deadline_request_reject:{operation_key:"d3",task_id:"T-1"},
  inbox_add:{operation_key:"1",content:"x",capture_key:"c"}, inbox_list:{}, inbox_get:{id:"I-1"}, inbox_discard:{operation_key:"2",id:"I-1"}, inbox_commit:{operation_key:"3",id:"I-1",tasks:[{title:"x",assignee:"Дубровин М.",project_id:"PRJ-1"}]},
  task_create:{operation_key:"4",title:"x",assignee:"Дубровин М.",project_id:"PRJ-1"}, task_list:{}, task_search:{search:"x"}, task_get:{id:"T-1"}, task_detail:{id:"T-1"}, task_history:{id:"T-1"}, task_update:{operation_key:"5",id:"T-1",title:"y"}, task_complete:{operation_key:"6",id:"T-1"}, task_cancel:{operation_key:"7",id:"T-1"},
  reminder_create:{operation_key:"rem1",task_id:"T-1",trigger_date:"2026-09-17",trigger_time:"12:00"}, reminder_list:{}, reminder_reschedule:{operation_key:"rem2",id:"REM-1",trigger_date:"2026-09-18",trigger_time:"18:00"}, reminder_cancel:{operation_key:"rem3",id:"REM-1"},
  recurrence_create:{operation_key:"r1",mode:"CALENDAR",rule:{kind:"DAYS",interval:1,start_date:"2026-09-08"},title:"Recurring",assignee_id:"P-1"}, recurrence_list:{}, recurrence_get:{id:"R-1"}, recurrence_detail:{id:"R-1"}, recurrence_history:{id:"R-1"}, recurrence_update:{operation_key:"r2",id:"R-1",title:"Updated"}, recurrence_pause:{operation_key:"r3",id:"R-1"}, recurrence_resume:{operation_key:"r4",id:"R-1"}, recurrence_cancel:{operation_key:"r5",id:"R-1"},
  project_create:{operation_key:"pr1",title:"Project"}, project_list:{}, project_get:{id:"PRJ-1"}, project_rename:{operation_key:"pr2",id:"PRJ-1",title:"Renamed"}, project_complete:{operation_key:"pr3",id:"PRJ-1"}, project_cancel:{operation_key:"pr4",id:"PRJ-1"}, task_project_set:{operation_key:"pr5",task_id:"T-1",project_id:"PRJ-1"},
  person_list:{}, person_resolve:{reference:"Дубровин М."}, person_create:{operation_key:"8",display_name:"Дима"}, person_rename:{operation_key:"9",id:"P-1",display_name:"X"}, person_alias_add:{operation_key:"10",id:"P-1",alias:"Max"}, person_alias_remove:{operation_key:"11",id:"P-1",alias:"Max"}, person_merge:{operation_key:"12",from_id:"P-2",into_id:"P-1"},
  label_list:{}, label_resolve:{reference:"СД"}, label_create:{operation_key:"13",display_name:"Совет директоров"}, label_rename:{operation_key:"14",id:"L-1",display_name:"SD"}, label_set_emoji:{operation_key:"14e",id:"L-1",emoji:"🏛"}, label_alias_add:{operation_key:"15",id:"L-1",alias:"СД"}, label_alias_remove:{operation_key:"16",id:"L-1",alias:"СД"}, label_delete:{operation_key:"16d",id:"L-1"}, label_merge:{operation_key:"17",from_id:"L-2",into_id:"L-1"},
  term_list:{}, term_resolve:{alias:"РГ"}, term_set:{operation_key:"18",alias:"РГ",expansion:"рабочая группа"}, term_remove:{operation_key:"19",alias:"РГ"},
  task_label_add:{operation_key:"20",task_id:"T-1",label_id:"L-1"}, task_label_remove:{operation_key:"21",task_id:"T-1",label_id:"L-1"}, comment_add:{operation_key:"22",task_id:"T-1",content:"status"}, comment_list:{task_id:"T-1"}, ref_resolve:{number:1,context:"task"},
};

describe("taskctl deterministic action registry",()=>{
  it("contains exactly the supported 63 actions",()=>{
    expect(TASKCTL_ACTIONS).toHaveLength(63);
    expect([...TASKCTL_ACTIONS].sort()).toEqual(Object.keys(VALID_PAYLOADS).sort());
    expect(Object.keys(ACTION_REGISTRY).sort()).toEqual(Object.keys(VALID_PAYLOADS).sort());
  });
  it("validates and sanitizes every action",()=>{
    for(const action of TASKCTL_ACTIONS) expect(validateAndSanitizePayload(action,VALID_PAYLOADS[action])).toEqual({ok:true,action,payload:VALID_PAYLOADS[action]});
    expect(validateAndSanitizePayload("task_create",{operation_key:"x",title:"x",assignee:"A",due_date:"2026-08-22",due_time:"10:30",project_id:"PRJ-1"})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("task_project_set",{operation_key:"x",task_id:"T-1",project_id:null})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("project_list",{status:"*",search:"ИИ",limit:10})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("label_set_emoji",{operation_key:"x",id:"L-1",emoji:null})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("recurrence_create",{operation_key:"bad-rule-1",mode:"CALENDAR",rule:{interval:1,unit:"DAYS"},title:"x",assignee_id:"P-1"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("recurrence_create",{operation_key:"bad-rule-2",mode:"AFTER_COMPLETION",rule:{kind:"DAYS",interval:1,start_date:"2026-09-08"},title:"x",assignee_id:"P-1",first_due_date:"2026-09-08"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("reminder_create",{operation_key:"rem",text:"Позвонить",trigger_date:"2026-09-17",trigger_time:"18:00"})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("reminder_create",{operation_key:"rem",task_id:"T-1",text:"bad",trigger_date:"2026-09-17",trigger_time:"18:00"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("reminder_create",{operation_key:"rem",trigger_date:"2026-09-17",trigger_time:"18:00"})).toMatchObject({ok:false});
  });
  it("keeps Operational Project contracts action-specific and fail-closed",()=>{
    expect(ACTION_REGISTRY.task_project_set.required).toEqual(["operation_key","task_id","project_id"]);
    expect(ACTION_REGISTRY.task_project_set.allowed).toEqual(["operation_key","task_id","project_id"]);
    expect(validateAndSanitizePayload("project_get",{id:"PRJ-1"})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("project_get",{id:1})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("project_get",{id:"1"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("project_get",{id:"P-1"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("task_project_set",{operation_key:"x",task_id:"T-1",project_id:"PRJ-1"})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("task_project_set",{operation_key:"x",task_id:"T-1",project_id:1})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("task_project_set",{operation_key:"x",task_id:"T-1",project_id:"1"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("task_project_set",{operation_key:"x",task_id:"T-1",project_id:null})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("task_project_set",{operation_key:"x",task_id:"T-1",project_id:"P-1"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("task_project_set",{operation_key:"x",task_id:"T-1",project_id:"PRJ-1",title:"bad"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("task_create",{operation_key:"x",title:"x",assignee:"A",project_id:null})).toMatchObject({ok:false});
  });
  it("keeps canonical Label deletion action-specific and minimal",()=>{
    expect(ACTION_REGISTRY.label_delete.argv).toEqual(["label","delete"]);
    expect(ACTION_REGISTRY.label_delete.required).toEqual(["operation_key","id"]);
    expect(ACTION_REGISTRY.label_delete.allowed).toEqual(["operation_key","id"]);
    expect(validateAndSanitizePayload("label_delete",{operation_key:"x",id:"L-1"})).toEqual({ok:true,action:"label_delete",payload:{operation_key:"x",id:"L-1"}});
    expect(validateAndSanitizePayload("label_delete",{operation_key:"x",id:"L-1",label_id:"L-1"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("label_delete",{operation_key:"x",id:"T-1"})).toMatchObject({ok:false});
  });
  it("keeps Task Label association contracts canonical-id-only",()=>{
    for(const action of ["task_label_add","task_label_remove"] as const){
      expect(ACTION_REGISTRY[action].required).toEqual(["operation_key","task_id","label_id"]);
      expect(ACTION_REGISTRY[action].allowed).toEqual(["operation_key","task_id","label_id"]);
      expect(validateAndSanitizePayload(action,{operation_key:"x",task_id:"T-1",label_id:"L-1"})).toEqual({ok:true,action,payload:{operation_key:"x",task_id:"T-1",label_id:"L-1"}});
      expect(validateAndSanitizePayload(action,{operation_key:"x",task_id:"T-1",label:"Board"})).toMatchObject({ok:false});
      expect(validateAndSanitizePayload(action,{operation_key:"x",task_id:"T-1",label_id:"L-1",create_label:true})).toMatchObject({ok:false});
    }
  });
  it("keeps Reminder contracts action-specific and canonical-id-only",()=>{
    expect(ACTION_REGISTRY.reminder_create.required).toEqual(["operation_key","trigger_date","trigger_time"]);
    expect(ACTION_REGISTRY.reminder_create.exactlyOneOf).toEqual([["task_id","text"]]);
    expect(validateAndSanitizePayload("reminder_create",{operation_key:"x",task_id:"T-1",trigger_date:"2026-09-17",trigger_time:"12:00"})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("reminder_create",{operation_key:"x",task_id:1,trigger_date:"2026-09-17",trigger_time:"12:00"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("reminder_reschedule",{operation_key:"x",id:"REM-1",trigger_date:"2026-09-17",trigger_time:"09:00"})).toMatchObject({ok:true});
    expect(validateAndSanitizePayload("reminder_reschedule",{operation_key:"x",id:"R-1",trigger_date:"2026-09-17",trigger_time:"09:00"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("reminder_cancel",{operation_key:"x",id:"1"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("reminder_list",{status:"ACTIVE"})).toMatchObject({ok:false});
  });
  it("rejects cross-action fields and incomplete updates",()=>{
    expect(validateAndSanitizePayload("inbox_commit",{operation_key:"x",content:"bad"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("task_update",{operation_key:"x",id:"T-1",reason:"only"})).toMatchObject({ok:false});
    expect(validateAndSanitizePayload("project_complete",{operation_key:"x",id:"PRJ-1",status:"DONE"})).toMatchObject({ok:false});
  });
  it("rejects malformed values, wrong entity ids, ambiguous alternatives, and invalid nested task specs",async()=>{
    const invalid:[string,Record<string,unknown>][]=[
      ["inbox_add",{operation_key:"x",capture_key:"c",content:7}],
      ["inbox_get",{id:"T-1"}],
      ["task_get",{id:"I-1"}],
      ["project_get",{id:"T-1"}],
      ["person_merge",{operation_key:"x",from_id:"L-2",into_id:"P-1"}],
      ["task_create",{operation_key:"x",title:"x",assignee_id:"P-1"}],
      ["task_create",{operation_key:"x",title:"x",assignee:"A",due_time:"10:00"}],
      ["task_create",{operation_key:"x",title:"x",assignee:"A",due_date:"2026-02-30"}],
      ["task_create",{operation_key:"x",title:"x",assignee:"A",project_id:"L-1"}],
      ["task_list",{limit:"10"}],
      ["project_list",{status:"OPEN"}],
      ["inbox_commit",{operation_key:"x",id:"I-1",tasks:[{title:"x",assignee_id:"P-1"}]}],
      ["inbox_commit",{operation_key:"x",id:"I-1",tasks:[{title:"x",assignee:"A",project_id:null}]}],
      ["inbox_commit",{operation_key:"x",id:"I-1",tasks:[{title:"x",assignee:"A",extra:true}]}],
      ["task_label_add",{operation_key:"x",task_id:"T-1",label:"A",label_id:"L-1"}],
      ["label_set_emoji",{operation_key:"x",id:"L-1",emoji:""}],
      ["reminder_create",{operation_key:"x",task_id:"T-1",text:"both",trigger_date:"2026-09-17",trigger_time:"12:00"}],
      ["reminder_create",{operation_key:"x",task_id:"T-1",trigger_date:"2026-02-30",trigger_time:"12:00"}],
      ["reminder_reschedule",{operation_key:"x",id:"REM-1",trigger_date:"2026-09-17",trigger_time:"25:00"}],
    ];
    for(const [action,payload] of invalid)expect(validateAndSanitizePayload(action,payload),action).toMatchObject({ok:false});
    let spawned=false;
    const result=await executeTaskctl("task_complete",{operation_key:"x",id:"I-1"},{spawnImpl:(()=>{spawned=true;throw new Error("must not spawn");}) as never});
    expect(result).toMatchObject({ok:false,error:{code:"TASKCTL_VALIDATION_ERROR"}});
    expect(spawned).toBe(false);
  });
  it("keeps a fixed executable and shell-free argv",()=>{
    const x=buildInvocation("task_project_set",VALID_PAYLOADS.task_project_set);
    expect(x.executable).toBe(TASKCTL_EXECUTABLE); expect(x.argv).toEqual(["task-project","set"]); expect(x.options.shell).toBe(false);
    expect(x.options.env).not.toHaveProperty("TASKCTL_DB"); expect(x.options.env).not.toHaveProperty("NODE_OPTIONS");
  });
});

describe("taskctl temp database integration",()=>{
  it("supports Projects while preserving canonical identity, labels, comments, history, search, and short refs",()=>{
    const directory=mkdtempSync(join(tmpdir(),"taskctl-v5-plugin-")),database=join(directory,"tasks.sqlite3");
    const invoke=(scope:string,action:string,payload:Record<string,unknown>)=>{const r=spawnSync(CANDIDATE_TASKCTL,[scope,action],{encoding:"utf8",env:{HOME:process.env.HOME??"/home/dubrovin",PATH:process.env.PATH??"/usr/bin:/bin",LANG:"C.UTF-8",TZ:"Europe/Moscow",TASKCTL_ALLOW_DB_OVERRIDE:"1",TASKCTL_DB:database,TASKCTL_PAYLOAD:JSON.stringify(payload)}});expect(r.status,r.stdout||r.stderr).toBe(0);return JSON.parse(r.stdout);};
    try{
      invoke("person","create",{operation_key:"p",display_name:"Дима"}); invoke("person","alias_add",{operation_key:"pa",id:"P-2",alias:"Дмитрий"});
      invoke("label","create",{operation_key:"l",display_name:"Совет директоров",emoji:"🏛"}); invoke("label","alias_add",{operation_key:"la",id:"L-1",alias:"СД"});
      invoke("project","create",{operation_key:"pr",title:"Подготовить СД"});
      invoke("task","create",{operation_key:"t",title:"Прислать бюджет",assignee:"Дмитрий",due_date:"2026-08-22",project_id:"PRJ-1"});
      const resolved=invoke("label","resolve",{reference:"СД"});
      expect(resolved).toMatchObject({matches:[{id:"L-1",display_name:"Совет директоров",emoji:"🏛",task_association_count:0}]});
      invoke("task-label","add",{operation_key:"tl-add",task_id:"T-1",label_id:resolved.matches[0].id});
      expect(invoke("task","detail",{id:"T-1"})).toMatchObject({task:{assignee:"Дима",assignee_is_self:false,label_emojis:["🏛"],project_id:"PRJ-1",project_title:"Подготовить СД"},labels:[{id:"L-1",display_name:"Совет директоров",emoji:"🏛"}],original_deadline:{due_date:"2026-08-22"}});
      expect(invoke("project","get",{id:"PRJ-1"})).toMatchObject({project:{id:"PRJ-1",status:"ACTIVE",task_counts:{total:1,OPEN:1,DONE:0,CANCELLED:0}},tasks:[{id:"T-1"}]});
      invoke("comment","add",{operation_key:"c",task_id:"T-1",content:"Ждем Минфин"});
      expect(invoke("task","detail",{id:"T-1"})).toMatchObject({original_deadline:{due_date:"2026-08-22"},deadline_change_count:0,recent_comments:[{content:"Ждем Минфин"}]});
      expect(invoke("label","resolve",{reference:"СД"})).toMatchObject({matches:[{display_name:"Совет директоров",emoji:"🏛",task_association_count:1}]});
      expect(invoke("task","search",{search:"Минфин"})).toMatchObject({count:1,tasks:[{id:"T-1",label_emojis:["🏛"],project_id:"PRJ-1"}]}); expect(invoke("ref","resolve",{number:1,context:"task"})).toMatchObject({id:"T-1"});
      invoke("task-project","set",{operation_key:"clear-project",task_id:"T-1",project_id:null});
      expect(invoke("task","get",{id:"T-1"})).toMatchObject({task:{project_id:null}});
      invoke("task-label","remove",{operation_key:"tl-remove",task_id:"T-1",label_id:"L-1"});
      expect(invoke("task","detail",{id:"T-1"})).toMatchObject({labels:[]});
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});
