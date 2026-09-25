'use strict';

const {
  fs, os, path, crypto, spawnSync, contacts, TZ, SELF_NAME, AppError,
  now, localDate, localTime, addLocalDays, required, optionalString, emojiValue,
  date, time, deadline, id, projectId, recurrenceId, reminderId, calendarDate,
  localDateAt, localDateTimeAt, futureReminderInstant, addLocalMonths, dayDiff,
  normalizeRule, calendarEligible, afterDueDate, hash, ci,
} = require('./runtime.cjs');

function ensureSelf(db){return contacts.ensureSingleSelf(db,'contacts',SELF_NAME).id;}
function createOrReusePerson(db,name,at=now()){
  const result=contacts.createOrReuse(db,{display_name:name},{schema:'contacts',at});
  if(result.outcome==='AMBIGUOUS')throw new AppError('AMBIGUOUS_PERSON','Person reference is ambiguous',{reference:name,candidates:result.matches.map(fmtPerson)});
  return{person:result.person,created:result.created};
}

function createOrReuseLabel(db, name, at=now()) {
  const matches=labelsMatching(db,name);
  if(matches.length===1)return{label:matches[0],created:false};
  if(matches.length>1)throw new AppError('AMBIGUOUS_LABEL','Label reference is ambiguous',{reference:name,candidates:matches.map(fmtLabel)});
  const lid=Number(db.prepare('INSERT INTO labels(display_name,emoji,created_at) VALUES(?,NULL,?)').run(name,at).lastInsertRowid);
  return{label:db.prepare('SELECT * FROM labels WHERE id=?').get(lid),created:true};
}

const fmtInbox=r=>({id:`I-${r.id}`,content:r.content,received_at:r.received_at,capture_key:r.capture_key});
const fmtPerson=r=>({id:`P-${r.id}`,display_name:r.display_name,created_at:r.created_at});
const fmtLabel=r=>({id:`L-${r.id}`,display_name:r.display_name,emoji:r.emoji??null,created_at:r.created_at});
const fmtProject=r=>({id:`PRJ-${r.id}`,title:r.title,status:r.status,created_at:r.created_at,completed_at:r.completed_at});
const fmtComment=r=>({id:`C-${r.id}`,task_id:`T-${r.task_id}`,content:r.content,created_at:r.created_at});
const fmtEvent=r=>({id:`E-${r.id}`,task_id:`T-${r.task_id}`,event_type:r.event_type,old_value:r.old_value,new_value:r.new_value,reason:r.reason,occurred_at:r.occurred_at});
function taskRow(db,n){return db.prepare("SELECT t.*,p.id assignee_canonical_id,p.display_name assignee,p.is_self assignee_is_self,pr.title project_title,pr.status project_status FROM tasks t JOIN contacts.people ps ON ps.id=t.assignee_id JOIN contacts.people p ON p.id=CASE WHEN ps.status='MERGED' THEN ps.merged_into ELSE ps.id END LEFT JOIN projects pr ON pr.id=t.project_id WHERE t.id=?").get(n);}
const fmtTask=r=>({id:`T-${r.id}`,title:r.title,assignee_id:`P-${r.assignee_canonical_id??r.assignee_id}`,assignee:r.assignee,assignee_is_self:Boolean(r.assignee_is_self),status:r.status,due_date:r.due_date,due_time:r.due_time,project_id:r.project_id===null?null:`PRJ-${r.project_id}`,project_title:r.project_title??null,project_status:r.project_status??null,created_at:r.created_at,completed_at:r.completed_at});
function mutate(db,type,p,fn){ const key=required(p,'operation_key',500),h=hash(p),prior=db.prepare('SELECT * FROM operation_results WHERE operation_key=?').get(key); if(prior){if(prior.operation_type!==type||prior.request_hash!==h) throw new AppError('IDEMPOTENCY_KEY_REUSE','operation_key was already used for a different request'); return {...JSON.parse(prior.result_json),idempotent_replay:true};} db.exec('BEGIN IMMEDIATE;'); try{const result=fn(); db.prepare('INSERT INTO operation_results VALUES(?,?,?,?,?)').run(key,type,h,JSON.stringify(result),now()); db.exec('COMMIT;'); return result;}catch(e){try{db.exec('ROLLBACK;');}catch{} throw e;} }
function event(db,taskId,type,oldV,newV,reason=null,at=now()){db.prepare('INSERT INTO task_events(task_id,event_type,old_value,new_value,reason,occurred_at) VALUES(?,?,?,?,?,?)').run(taskId,type,oldV,newV,reason,at);}

function peopleMatching(db,ref){return contacts.matchingPeople(db,ref,{schema:'contacts'});}
function resolvePerson(db,ref,{create=false,at=now()}={}){
  if(ref===undefined||ref===null||(typeof ref==='string'&&!ref.trim()))throw new AppError('INVALID_FIELD','assignee/person reference is required');
  const result=contacts.resolve(db,ref,{schema:'contacts'});
  if(result.outcome==='MATCH')return result.matches[0];
  if(result.outcome==='AMBIGUOUS')throw new AppError('AMBIGUOUS_PERSON','Person reference is ambiguous',{reference:ref,candidates:result.matches.map(fmtPerson)});
  if(!create)throw new AppError('PERSON_NOT_FOUND','No canonical Person matches the reference',{reference:ref});
  return createOrReusePerson(db,String(ref??'').trim(),at).person;
}
function labelsMatching(db,ref){const q=ci(ref),out=new Map(); for(const r of db.prepare('SELECT * FROM labels').all())if(ci(r.display_name)===q)out.set(r.id,r); for(const a of db.prepare('SELECT la.*,l.display_name,l.emoji,l.created_at FROM label_aliases la JOIN labels l ON l.id=la.label_id').all())if(ci(a.alias)===q)out.set(a.label_id,{id:a.label_id,display_name:a.display_name,emoji:a.emoji,created_at:a.created_at}); return [...out.values()];}
function resolveLabel(db,ref,{create=false,at=now()}={}){if(Number.isSafeInteger(ref)||(typeof ref==='string'&&/^(?:L-)?[1-9]\d*$/i.test(ref.trim()))){const n=id(ref,'L'),r=db.prepare('SELECT * FROM labels WHERE id=?').get(n); if(!r)throw new AppError('NOT_FOUND',`Label L-${n} not found`,undefined,3); return r;} const name=String(ref??'').trim(); if(!name)throw new AppError('INVALID_FIELD','label reference is required'); const m=labelsMatching(db,name); if(m.length===1)return m[0]; if(m.length>1)throw new AppError('AMBIGUOUS_LABEL','Label reference is ambiguous',{reference:name,candidates:m.map(fmtLabel)}); if(!create)throw new AppError('LABEL_NOT_FOUND','No canonical Label matches the reference',{reference:name}); return createOrReuseLabel(db,name,at).label; }
function resolveProject(db,ref){const n=projectId(ref),r=db.prepare('SELECT * FROM projects WHERE id=?').get(n);if(!r)throw new AppError('NOT_FOUND',`Project PRJ-${n} not found`,undefined,3);return r;}
function requireActiveProject(db,ref){const r=resolveProject(db,ref);if(r.status!=='ACTIVE')throw new AppError('INVALID_STATE',`Project PRJ-${r.id} is ${r.status} and cannot accept a new Task association`,{project:fmtProject(r)});return r;}
function projectCounts(db,n){const rows=db.prepare('SELECT status,count(*) n FROM tasks WHERE project_id=? GROUP BY status').all(n),counts={total:0,OPEN:0,DONE:0,CANCELLED:0};for(const r of rows){counts[r.status]=Number(r.n);counts.total+=Number(r.n);}return counts;}
function projectPresented(db,r){return{...fmtProject(r),task_counts:projectCounts(db,r.id)};}



const TASK_BINDINGS=new Set(['OFFICE_CEO_GROUP','PERSONAL_LABEL']);
function bindingRow(db,key){
  if(!TASK_BINDINGS.has(key))throw new AppError('INVALID_FIELD','Unsupported Task domain binding',{binding_key:key});
  return db.prepare('SELECT * FROM task_domain_bindings WHERE binding_key=?').get(key)??null;
}
function requireOfficeCeoGroup(db){
  const binding=bindingRow(db,'OFFICE_CEO_GROUP');
  if(!binding)throw new AppError('OFFICE_CEO_BINDING_MISSING','Office CEO Person Group binding is not configured');
  const group=contacts.rawPersonGroup(db,binding.entity_id,'contacts');
  if(!group)throw new AppError('OFFICE_CEO_GROUP_MISSING','Bound Office CEO Person Group does not exist',{group_id:'PG-'+binding.entity_id});
  return group;
}
function requirePersonalLabel(db){
  const binding=bindingRow(db,'PERSONAL_LABEL');
  if(!binding)throw new AppError('PERSONAL_LABEL_BINDING_MISSING','Personal Label binding is not configured');
  const label=db.prepare('SELECT * FROM labels WHERE id=?').get(binding.entity_id);
  if(!label)throw new AppError('PERSONAL_LABEL_MISSING','Bound personal Label does not exist',{label_id:'L-'+binding.entity_id});
  return label;
}
function personInOfficeCeo(db,personId){
  const group=requireOfficeCeoGroup(db);
  try{return contacts.personInGroup(db,group.id,personId,'contacts');}
  catch(error){throw new AppError('OFFICE_CEO_MEMBERSHIP_UNAVAILABLE',error.message);}
}
function taskIsPersonal(db,taskId){
  const label=requirePersonalLabel(db);
  return Boolean(db.prepare('SELECT 1 ok FROM task_labels WHERE task_id=? AND label_id=?').get(taskId,label.id));
}
function taskBinding(db,action,p){
  if(action==='get'){
    const key=required(p,'key',100),row=bindingRow(db,key);
    return{ok:true,binding:row?{key:row.binding_key,entity_id:key==='OFFICE_CEO_GROUP'?'PG-'+row.entity_id:'L-'+row.entity_id,created_at:row.created_at,updated_at:row.updated_at}:null};
  }
  if(action==='validate'){
    const group=requireOfficeCeoGroup(db),label=requirePersonalLabel(db);
    return{ok:true,office_ceo_group_id:'PG-'+group.id,personal_label_id:'L-'+label.id};
  }
  if(action==='set')return mutate(db,'config.binding_set',p,()=>{
    const key=required(p,'key',100);
    if(!TASK_BINDINGS.has(key))throw new AppError('INVALID_FIELD','Unsupported Task domain binding',{binding_key:key});
    const raw=required(p,'entity_id',100);let entityId;
    if(key==='OFFICE_CEO_GROUP'){
      try{entityId=contacts.personGroupNumber(raw);}catch{throw new AppError('INVALID_ID','OFFICE_CEO_GROUP requires a canonical PG-* identifier');}
      if(!contacts.rawPersonGroup(db,entityId,'contacts'))throw new AppError('NOT_FOUND','Person Group PG-'+entityId+' not found',undefined,3);
    }else{
      entityId=id(raw,'L');
      if(!db.prepare('SELECT 1 FROM labels WHERE id=?').get(entityId))throw new AppError('NOT_FOUND','Label L-'+entityId+' not found',undefined,3);
    }
    const at=now(),prior=bindingRow(db,key);
    if(prior?.entity_id===entityId)return{ok:true,binding:{key,entity_id:key==='OFFICE_CEO_GROUP'?'PG-'+entityId:'L-'+entityId},changed:false};
    db.prepare('INSERT INTO task_domain_bindings(binding_key,entity_id,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(binding_key) DO UPDATE SET entity_id=excluded.entity_id,updated_at=excluded.updated_at').run(key,entityId,prior?.created_at??at,at);
    return{ok:true,binding:{key,entity_id:key==='OFFICE_CEO_GROUP'?'PG-'+entityId:'L-'+entityId},changed:true};
  });
  throw new AppError('USAGE','Unknown config binding action: '+action);
}
function fmtDeadlineChangeRequest(r){
  return{id:'DCR-'+r.id,task_id:'T-'+r.task_id,base_due_date:r.base_due_date??null,base_due_time:r.base_due_time??null,requested_due_date:r.requested_due_date??null,requested_due_time:r.requested_due_time??null,reason:r.reason,status:r.status,approved_due_date:r.approved_due_date??null,approved_due_time:r.approved_due_time??null,created_at:r.created_at,resolved_at:r.resolved_at??null};
}
function pendingDeadlineChangeRequest(db,taskId){
  return db.prepare("SELECT * FROM deadline_change_requests WHERE task_id=? AND status='PENDING' ORDER BY id DESC LIMIT 1").get(taskId)??null;
}
function deadlineRequestHistory(db,taskId){
  return db.prepare('SELECT * FROM deadline_change_requests WHERE task_id=? ORDER BY id').all(taskId).map(fmtDeadlineChangeRequest);
}
function closePendingDeadlineRequest(db,taskId,at){const req=pendingDeadlineChangeRequest(db,taskId);if(!req)return null;db.prepare("UPDATE deadline_change_requests SET status='SUPERSEDED',resolved_at=? WHERE id=? AND status='PENDING'").run(at,req.id);return fmtDeadlineChangeRequest(db.prepare('SELECT * FROM deadline_change_requests WHERE id=?').get(req.id));}
function applyEffectiveDeadline(db,taskId,current,targetDate,targetTime,reason,at){
  const sets=[],vals=[],events=[];
  if(targetDate!==current.due_date){sets.push('due_date=?');vals.push(targetDate);events.push(['DUE_DATE_CHANGED',current.due_date,targetDate,reason]);}
  if(targetTime!==current.due_time){sets.push('due_time=?');vals.push(targetTime);events.push(['DUE_TIME_CHANGED',current.due_time,targetTime,reason]);}
  if(!sets.length)return false;
  db.prepare('UPDATE tasks SET '+sets.join(',')+' WHERE id=?').run(...vals,taskId);
  for(const e of events)event(db,taskId,...e,at);
  return true;
}
function deadlineRequest(db,action,p){
  const taskId=id(p.task_id,'T'),task=taskRow(db,taskId);
  if(!task)throw new AppError('NOT_FOUND','Task T-'+taskId+' not found',undefined,3);
  if(action==='get'){
    const pending=pendingDeadlineChangeRequest(db,taskId);
    return{ok:true,task:taskPresented(db,task),governance:{office_ceo:personInOfficeCeo(db,task.assignee_canonical_id)},pending:pending?fmtDeadlineChangeRequest(pending):null,history:deadlineRequestHistory(db,taskId)};
  }
  if(action==='create')return mutate(db,'deadline_request.create',p,()=>{
    const current=taskRow(db,taskId);
    if(current.status!=='OPEN')throw new AppError('INVALID_STATE','Deadline Change Request requires an OPEN Task');
    if(personInOfficeCeo(db,current.assignee_canonical_id))throw new AppError('DIRECT_DEADLINE_CHANGE_ALLOWED','Office CEO Task deadlines are changed directly rather than through a Deadline Change Request');
    if(!('due_date'in p)&&!('due_time'in p))throw new AppError('INVALID_FIELD','Deadline Change Request requires due_date and/or due_time');
    const targetDate='due_date'in p?date(p.due_date):current.due_date,targetTime='due_time'in p?time(p.due_time):current.due_time;
    deadline(targetDate,targetTime);
    if(targetDate===current.due_date&&targetTime===current.due_time)throw new AppError('INVALID_FIELD','Requested deadline must differ from the effective Task deadline');
    const reason=required(p,'reason',2000),at=now(),prior=pendingDeadlineChangeRequest(db,taskId);
    if(prior)db.prepare("UPDATE deadline_change_requests SET status='SUPERSEDED',resolved_at=? WHERE id=? AND status='PENDING'").run(at,prior.id);
    const rid=Number(db.prepare("INSERT INTO deadline_change_requests(task_id,base_due_date,base_due_time,requested_due_date,requested_due_time,reason,status,approved_due_date,approved_due_time,created_at,resolved_at) VALUES(?,?,?,?,?,?,'PENDING',NULL,NULL,?,NULL)").run(taskId,current.due_date,current.due_time,targetDate,targetTime,reason,at).lastInsertRowid);
    return{ok:true,request:fmtDeadlineChangeRequest(db.prepare('SELECT * FROM deadline_change_requests WHERE id=?').get(rid)),superseded:prior?fmtDeadlineChangeRequest(db.prepare('SELECT * FROM deadline_change_requests WHERE id=?').get(prior.id)):null};
  });
  if(action==='approve')return mutate(db,'deadline_request.approve',p,()=>{
    const current=taskRow(db,taskId);
    if(current.status!=='OPEN')throw new AppError('INVALID_STATE','Only an OPEN Task deadline request can be approved');
    const req=pendingDeadlineChangeRequest(db,taskId);
    if(!req)throw new AppError('NOT_FOUND','Task T-'+taskId+' has no pending Deadline Change Request',undefined,3);
    if(current.due_date!==req.base_due_date||current.due_time!==req.base_due_time)throw new AppError('STALE_DEADLINE_REQUEST','Effective Task deadline changed after the request was created',{effective:{due_date:current.due_date,due_time:current.due_time},base:{due_date:req.base_due_date,due_time:req.base_due_time}});
    const override='due_date'in p||'due_time'in p,targetDate='due_date'in p?date(p.due_date):req.requested_due_date,targetTime='due_time'in p?time(p.due_time):req.requested_due_time;
    deadline(targetDate,targetTime);
    if(targetDate===current.due_date&&targetTime===current.due_time)throw new AppError('INVALID_FIELD','Approval deadline must differ from the current effective deadline; reject the request to keep it');
    const at=now();applyEffectiveDeadline(db,taskId,current,targetDate,targetTime,req.reason,at);
    db.prepare("UPDATE deadline_change_requests SET status='APPROVED',approved_due_date=?,approved_due_time=?,resolved_at=? WHERE id=? AND status='PENDING'").run(targetDate,targetTime,at,req.id);
    return{ok:true,request:fmtDeadlineChangeRequest(db.prepare('SELECT * FROM deadline_change_requests WHERE id=?').get(req.id)),task:taskPresented(db,taskRow(db,taskId)),modified_from_request:override&&(targetDate!==req.requested_due_date||targetTime!==req.requested_due_time)};
  });
  if(action==='reject')return mutate(db,'deadline_request.reject',p,()=>{
    const req=pendingDeadlineChangeRequest(db,taskId);
    if(!req)throw new AppError('NOT_FOUND','Task T-'+taskId+' has no pending Deadline Change Request',undefined,3);
    const at=now();db.prepare("UPDATE deadline_change_requests SET status='REJECTED',resolved_at=? WHERE id=? AND status='PENDING'").run(at,req.id);
    return{ok:true,request:fmtDeadlineChangeRequest(db.prepare('SELECT * FROM deadline_change_requests WHERE id=?').get(req.id)),task:taskPresented(db,taskRow(db,taskId))};
  });
  throw new AppError('USAGE','Unknown deadline-request action: '+action);
}


function recurrenceLabels(db,n){return db.prepare('SELECT l.* FROM labels l JOIN recurrence_labels rl ON rl.label_id=l.id WHERE rl.recurrence_id=? ORDER BY l.display_name,l.id').all(n).map(fmtLabel);}
function recurrenceTemplate(db,r){return{title:r.title,assignee_id:`P-${r.assignee_canonical_id??r.assignee_id}`,label_ids:recurrenceLabels(db,r.id).map(x=>x.id),target_project_id:r.target_project_id===null?null:`PRJ-${r.target_project_id}`,due_time:r.due_time??null};}
function recurrenceRule(r){try{return JSON.parse(r.rule_json);}catch{throw new AppError('INTEGRITY_ERROR',`Recurrence R-${r.id} has invalid rule JSON`);}}
function recurrenceEvent(db,n,type,oldV,newV,reason=null,at=now()){db.prepare('INSERT INTO recurrence_events(recurrence_id,event_type,old_value,new_value,reason,occurred_at) VALUES(?,?,?,?,?,?)').run(n,type,oldV===undefined?null:JSON.stringify(oldV),newV===undefined?null:JSON.stringify(newV),reason,at);}
function recurrenceRow(db,n){return db.prepare("SELECT r.*,p.id assignee_canonical_id,p.display_name assignee,p.is_self assignee_is_self,pr.title project_title,pr.status project_status FROM recurrences r JOIN contacts.people ps ON ps.id=r.assignee_id JOIN contacts.people p ON p.id=CASE WHEN ps.status='MERGED' THEN ps.merged_into ELSE ps.id END LEFT JOIN projects pr ON pr.id=r.target_project_id WHERE r.id=?").get(n);}
function recurrencePresented(db,r){return{id:`R-${r.id}`,status:r.status,mode:r.mode,rule:recurrenceRule(r),template:{...recurrenceTemplate(db,r),assignee:r.assignee,project_title:r.project_title??null,project_status:r.project_status??null},created_at:r.created_at,updated_at:r.updated_at,cancelled_at:r.cancelled_at??null};}
function occurrencePresented(r){return{id:`RO-${r.id}`,recurrence_id:`R-${r.recurrence_id}`,occurrence_key:r.occurrence_key,occurrence_date:r.occurrence_date??null,predecessor_task_id:r.predecessor_task_id===null?null:`T-${r.predecessor_task_id}`,task_id:`T-${r.task_id}`,template:JSON.parse(r.template_json),generated_at:r.generated_at};}
function occurrenceForTask(db,n){const r=db.prepare('SELECT * FROM recurrence_occurrences WHERE task_id=?').get(n);return r?occurrencePresented(r):null;}
function recurrenceForTask(db,n){const o=db.prepare('SELECT * FROM recurrence_occurrences WHERE task_id=?').get(n);if(!o)return null;const r=recurrenceRow(db,o.recurrence_id);return r?{occurrence:o,recurrence:r}:null;}
function recurrenceTaskProvenance(db,n){const x=recurrenceForTask(db,n);return x?{recurrence_id:`R-${x.recurrence.id}`,mode:x.recurrence.mode,occurrence_key:x.occurrence.occurrence_key,occurrence_date:x.occurrence.occurrence_date??null,predecessor_task_id:x.occurrence.predecessor_task_id===null?null:`T-${x.occurrence.predecessor_task_id}`}:null;}
function recurrenceLabelIds(db,n){return recurrenceLabels(db,n).map(x=>Number(x.id.slice(2)));}
function canonicalLabelIds(db,value){if(value===undefined)return[];if(!Array.isArray(value)||value.length>20)throw new AppError('INVALID_FIELD','label_ids must be an array of at most 20 canonical Label ids');const out=[];for(const x of value){const n=id(x,'L');if(!db.prepare('SELECT 1 FROM labels WHERE id=?').get(n))throw new AppError('NOT_FOUND',`Label L-${n} not found`,undefined,3);if(!out.includes(n))out.push(n);}return out;}
function setRecurrenceLabels(db,n,ids){db.prepare('DELETE FROM recurrence_labels WHERE recurrence_id=?').run(n);for(const lid of ids)db.prepare('INSERT INTO recurrence_labels(recurrence_id,label_id) VALUES(?,?)').run(n,lid);}
function insertRecurrence(db,spec,at){const info=db.prepare("INSERT INTO recurrences(status,mode,title,assignee_id,due_time,target_project_id,rule_json,calendar_cursor_date,created_at,updated_at,cancelled_at) VALUES('ACTIVE',?,?,?,?,?,?,?,?,?,NULL)").run(spec.mode,spec.title,spec.assignee_id,spec.due_time,spec.target_project_id,JSON.stringify(spec.rule),spec.calendar_cursor_date,at,at);const n=Number(info.lastInsertRowid);setRecurrenceLabels(db,n,spec.label_ids);return recurrenceRow(db,n);}
function linkOccurrence(db,rec,key,occurrenceDate,taskId,predecessorTaskId,at){const prior=db.prepare('SELECT * FROM recurrence_occurrences WHERE recurrence_id=? AND occurrence_key=?').get(rec.id,key);if(prior){if(prior.task_id!==taskId)throw new AppError('INTEGRITY_ERROR','Occurrence identity is already linked to another Task');return occurrencePresented(prior);}const byTask=db.prepare('SELECT * FROM recurrence_occurrences WHERE task_id=?').get(taskId);if(byTask)throw new AppError('INVALID_STATE',`Task T-${taskId} already belongs to Recurrence R-${byTask.recurrence_id}`);const snap=recurrenceTemplate(db,rec);const info=db.prepare('INSERT INTO recurrence_occurrences(recurrence_id,occurrence_key,occurrence_date,predecessor_task_id,task_id,template_json,generated_at) VALUES(?,?,?,?,?,?,?)').run(rec.id,key,occurrenceDate,predecessorTaskId,taskId,JSON.stringify(snap),at);return occurrencePresented(db.prepare('SELECT * FROM recurrence_occurrences WHERE id=?').get(Number(info.lastInsertRowid)));}
function createGeneratedOccurrence(db,rec,key,occurrenceDate,dueDate,predecessorTaskId,at){const prior=db.prepare('SELECT * FROM recurrence_occurrences WHERE recurrence_id=? AND occurrence_key=?').get(rec.id,key);if(prior)return{occurrence:occurrencePresented(prior),task:taskPresented(db,taskRow(db,prior.task_id)),created:false};const labels=recurrenceLabelIds(db,rec.id).map(x=>({id:`L-${x}`}));const spec={title:rec.title,assignee_id:`P-${rec.assignee_id}`,due_date:dueDate,due_time:rec.due_time??null,labels,...(rec.target_project_id===null?{}:{project_id:`PRJ-${rec.target_project_id}`})};const task=createTask(db,spec,at);const taskId=Number(task.id.slice(2));const occ=linkOccurrence(db,rec,key,occurrenceDate,taskId,predecessorTaskId,at);return{occurrence:occ,task:taskPresented(db,taskRow(db,taskId)),created:true};}
function materializeCalendarRecurrence(db,rec,boundary,at){if(rec.mode!=='CALENDAR'||rec.status!=='ACTIVE')return[];calendarDate(boundary,'materialization boundary');let cursor=rec.calendar_cursor_date;if(!cursor)throw new AppError('INTEGRITY_ERROR',`Calendar Recurrence R-${rec.id} has no cursor`);if(boundary<=cursor)return[];const span=dayDiff(cursor,boundary);if(span>36600)throw new AppError('MATERIALIZATION_BOUND_EXCEEDED','Calendar materialization exceeds the 100-year catch-up bound',{recurrence_id:`R-${rec.id}`,span_days:span});const rule=normalizeRule('CALENDAR',recurrenceRule(rec)),out=[];for(let d=addLocalDays(cursor,1);d<=boundary;d=addLocalDays(d,1)){if(calendarEligible(rule,d))out.push(createGeneratedOccurrence(db,rec,`calendar:${d}`,d,d,null,at));}db.prepare('UPDATE recurrences SET calendar_cursor_date=? WHERE id=?').run(boundary,rec.id);return out;}
function materializeCalendars(db,boundary=localDate(),at=now()){const rows=db.prepare("SELECT * FROM recurrences WHERE status='ACTIVE' AND mode='CALENDAR' ORDER BY id").all(),out=[];for(const raw of rows){const rec=recurrenceRow(db,raw.id);for(const x of materializeCalendarRecurrence(db,rec,boundary,at))if(x.created)out.push({recurrence_id:`R-${rec.id}`,task:x.task,occurrence:x.occurrence});}return{ok:true,boundary,materialized:out,count:out.length};}
function afterSuccessor(db,rec,predecessorTaskId,anchorDate,at){const prior=db.prepare('SELECT * FROM recurrence_occurrences WHERE predecessor_task_id=?').get(predecessorTaskId);if(prior)return{occurrence:occurrencePresented(prior),task:taskPresented(db,taskRow(db,prior.task_id)),created:false};const rule=normalizeRule('AFTER_COMPLETION',recurrenceRule(rec)),due=afterDueDate(anchorDate,rule);return createGeneratedOccurrence(db,rec,`after:T-${predecessorTaskId}`,null,due,predecessorTaskId,at);}
function latestOccurrence(db,n){return db.prepare('SELECT ro.*,t.status task_status,t.due_date task_due_date FROM recurrence_occurrences ro JOIN tasks t ON t.id=ro.task_id WHERE ro.recurrence_id=? ORDER BY ro.id DESC LIMIT 1').get(n);}
function recurrenceProjectBlockers(db,n){return db.prepare("SELECT id FROM recurrences WHERE target_project_id=? AND status IN ('ACTIVE','PAUSED') ORDER BY id").all(n).map(x=>`R-${x.id}`);}
function recurrenceCreate(db,p){return mutate(db,'recurrence.create',p,()=>{const mode=p.mode;if(!['CALENDAR','AFTER_COMPLETION'].includes(mode))throw new AppError('INVALID_FIELD','mode must be CALENDAR or AFTER_COMPLETION');const rule=normalizeRule(mode,p.rule),at=now(),today=localDate(),seed='seed_task_id'in p?id(p.seed_task_id,'T'):null;let title,assigneeId,labelIds,targetProjectId,dueTime;
  if(seed!==null){for(const k of ['title','assignee_id','label_ids','target_project_id','due_time','first_due_date'])if(k in p)throw new AppError('INVALID_FIELD','Seed recurrence template is derived from the existing Task');const task=taskRow(db,seed);if(!task)throw new AppError('NOT_FOUND',`Task T-${seed} not found`,undefined,3);if(task.status!=='OPEN')throw new AppError('INVALID_STATE','Only an OPEN Task can seed a Recurrence');if(recurrenceForTask(db,seed))throw new AppError('INVALID_STATE',`Task T-${seed} already belongs to a Recurrence`);title=task.title;assigneeId=task.assignee_canonical_id??task.assignee_id;labelIds=taskLabels(db,seed).map(x=>Number(x.id.slice(2)));targetProjectId=task.project_id;dueTime=task.due_time;if(targetProjectId!==null)requireActiveProject(db,`PRJ-${targetProjectId}`);if(mode==='CALENDAR'&&(task.due_date===null||task.due_date!==rule.start_date||!calendarEligible(rule,task.due_date)))throw new AppError('INVALID_FIELD','Calendar seed Task deadline must equal the first rule occurrence');
  }else{title=required(p,'title',2000);assigneeId=resolvePerson(db,p.assignee_id).id;labelIds=canonicalLabelIds(db,p.label_ids);targetProjectId=p.target_project_id===undefined||p.target_project_id===null?null:requireActiveProject(db,p.target_project_id).id;dueTime='due_time'in p?time(p.due_time):null;if(mode==='CALENDAR'){if('first_due_date'in p)throw new AppError('INVALID_FIELD','CALENDAR recurrence does not accept first_due_date');if(rule.start_date<today)throw new AppError('INVALID_FIELD','New CALENDAR recurrence start_date must be today or later when no seed Task exists');}else if(!('first_due_date'in p))throw new AppError('INVALID_FIELD','New AFTER_COMPLETION recurrence requires first_due_date when no seed Task exists');}
  const rec=insertRecurrence(db,{mode,title,assignee_id:assigneeId,label_ids:labelIds,target_project_id:targetProjectId,due_time:dueTime,rule,calendar_cursor_date:mode==='CALENDAR'?(seed!==null?today:addLocalDays(today,-1)):null},at);recurrenceEvent(db,rec.id,'CREATED',undefined,{mode,rule,template:recurrenceTemplate(db,rec)},null,at);let first=null;if(seed!==null){first=linkOccurrence(db,rec,mode==='CALENDAR'?`calendar:${taskRow(db,seed).due_date}`:`seed:T-${seed}`,taskRow(db,seed).due_date,seed,null,at);}else if(mode==='CALENDAR'){const m=materializeCalendarRecurrence(db,rec,today,at);first=m[0]?.occurrence??null;}else{const firstDate=calendarDate(p.first_due_date,'first_due_date');first=createGeneratedOccurrence(db,rec,'first',null,firstDate,null,at).occurrence;}return{ok:true,recurrence:recurrencePresented(db,recurrenceRow(db,rec.id)),first_occurrence:first};});}
function recurrenceList(db,p){const status=p.status??'ACTIVE';if(!['ACTIVE','PAUSED','CANCELLED','*'].includes(status))throw new AppError('INVALID_FIELD','status must be ACTIVE, PAUSED, CANCELLED, or *');const limit=Number.isSafeInteger(p.limit)?Math.min(Math.max(p.limit,1),200):100,rows=status==='*'?db.prepare('SELECT id FROM recurrences ORDER BY id LIMIT ?').all(limit):db.prepare('SELECT id FROM recurrences WHERE status=? ORDER BY id LIMIT ?').all(status,limit);return{ok:true,recurrences:rows.map(x=>recurrencePresented(db,recurrenceRow(db,x.id))),count:rows.length};}
function recurrenceDetail(db,n){const r=recurrenceRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Recurrence R-${n} not found`,undefined,3);const occ=db.prepare('SELECT * FROM recurrence_occurrences WHERE recurrence_id=? ORDER BY id').all(n).map(occurrencePresented),latest=latestOccurrence(db,n);const needs=r.mode==='AFTER_COMPLETION'&&r.status!=='CANCELLED'&&latest&&['DONE','CANCELLED'].includes(latest.task_status)&&!db.prepare('SELECT 1 FROM recurrence_occurrences WHERE predecessor_task_id=?').get(latest.task_id);return{ok:true,recurrence:recurrencePresented(db,r),occurrences:occ,needs_cycle_resolution:Boolean(needs)};}
function recurrenceUpdate(db,p){return mutate(db,'recurrence.update',p,()=>{const n=recurrenceId(p.id),r=recurrenceRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Recurrence R-${n} not found`,undefined,3);if(r.status==='CANCELLED')throw new AppError('INVALID_STATE','CANCELLED Recurrence is terminal');const mutable=['title','assignee_id','label_ids','target_project_id','due_time','rule','cycle_anchor_date'].filter(k=>k in p);if(!mutable.length)throw new AppError('INVALID_FIELD','recurrence_update requires at least one mutable field');const at=now(),today=localDate();if('cycle_anchor_date'in p){if(mutable.length!==1||r.mode!=='AFTER_COMPLETION'||r.status!=='ACTIVE')throw new AppError('INVALID_FIELD','cycle_anchor_date is only a standalone ACTIVE AFTER_COMPLETION update');const latest=latestOccurrence(db,n);if(!latest||!['DONE','CANCELLED'].includes(latest.task_status))throw new AppError('INVALID_STATE','A new cycle anchor requires a terminal current occurrence');const x=afterSuccessor(db,r,latest.task_id,calendarDate(p.cycle_anchor_date,'cycle_anchor_date'),at);recurrenceEvent(db,n,'CYCLE_ANCHORED',undefined,{anchor_date:p.cycle_anchor_date,successor_task_id:x.task.id},null,at);return{ok:true,recurrence:recurrencePresented(db,recurrenceRow(db,n)),successor:x.task};}
  if(r.mode==='CALENDAR'&&r.status==='ACTIVE')materializeCalendarRecurrence(db,r,today,at);const oldRule=recurrenceRule(r),oldTemplate=recurrenceTemplate(db,r);let title=r.title,assigneeId=r.assignee_id,labelIds=recurrenceLabelIds(db,n),targetProjectId=r.target_project_id,dueTime=r.due_time,rule=oldRule;if('title'in p)title=required(p,'title',2000);if('assignee_id'in p)assigneeId=resolvePerson(db,p.assignee_id).id;if('label_ids'in p)labelIds=canonicalLabelIds(db,p.label_ids);if('target_project_id'in p)targetProjectId=p.target_project_id===null?null:requireActiveProject(db,p.target_project_id).id;if('due_time'in p)dueTime=time(p.due_time);if('rule'in p)rule=normalizeRule(r.mode,p.rule);db.prepare('UPDATE recurrences SET title=?,assignee_id=?,due_time=?,target_project_id=?,rule_json=?,updated_at=? WHERE id=?').run(title,assigneeId,dueTime,targetProjectId,JSON.stringify(rule),at,n);setRecurrenceLabels(db,n,labelIds);if(JSON.stringify(rule)!==JSON.stringify(oldRule))recurrenceEvent(db,n,'RULE_CHANGED',oldRule,rule,null,at);const after=recurrenceRow(db,n),newTemplate=recurrenceTemplate(db,after);if(JSON.stringify(oldTemplate)!==JSON.stringify(newTemplate))recurrenceEvent(db,n,'TEMPLATE_CHANGED',oldTemplate,newTemplate,null,at);if(after.mode==='CALENDAR'&&after.status==='ACTIVE'){db.prepare('UPDATE recurrences SET calendar_cursor_date=? WHERE id=?').run(addLocalDays(today,-1),n);materializeCalendarRecurrence(db,recurrenceRow(db,n),today,at);}return{ok:true,recurrence:recurrencePresented(db,recurrenceRow(db,n))};});}
function recurrencePause(db,p){return mutate(db,'recurrence.pause',p,()=>{const n=recurrenceId(p.id),r=recurrenceRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Recurrence R-${n} not found`,undefined,3);if(r.status==='PAUSED')return{ok:true,recurrence:recurrencePresented(db,r),changed:false};if(r.status!=='ACTIVE')throw new AppError('INVALID_STATE','Only ACTIVE Recurrence can be paused');const at=now();if(r.mode==='CALENDAR')materializeCalendarRecurrence(db,r,localDate(),at);db.prepare("UPDATE recurrences SET status='PAUSED',updated_at=? WHERE id=?").run(at,n);recurrenceEvent(db,n,'PAUSED',{status:'ACTIVE'},{status:'PAUSED'},null,at);return{ok:true,recurrence:recurrencePresented(db,recurrenceRow(db,n)),changed:true};});}
function recurrenceResume(db,p){return mutate(db,'recurrence.resume',p,()=>{const n=recurrenceId(p.id),r=recurrenceRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Recurrence R-${n} not found`,undefined,3);if(r.status==='ACTIVE')return{ok:true,recurrence:recurrencePresented(db,r),changed:false};if(r.status!=='PAUSED')throw new AppError('INVALID_STATE','Only PAUSED Recurrence can be resumed');const at=now(),today=localDate();db.prepare("UPDATE recurrences SET status='ACTIVE',updated_at=? WHERE id=?").run(at,n);recurrenceEvent(db,n,'RESUMED',{status:'PAUSED'},{status:'ACTIVE'},null,at);let successor=null;const active=recurrenceRow(db,n);if(active.mode==='CALENDAR'){db.prepare('UPDATE recurrences SET calendar_cursor_date=? WHERE id=?').run(today,n);}else{const latest=latestOccurrence(db,n);if(latest&&['DONE','CANCELLED'].includes(latest.task_status)){const x=afterSuccessor(db,active,latest.task_id,today,at);successor=x.task;}}return{ok:true,recurrence:recurrencePresented(db,recurrenceRow(db,n)),changed:true,successor};});}
function recurrenceCancel(db,p){return mutate(db,'recurrence.cancel',p,()=>{const n=recurrenceId(p.id),r=recurrenceRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Recurrence R-${n} not found`,undefined,3);if(r.status==='CANCELLED')return{ok:true,recurrence:recurrencePresented(db,r),changed:false};const at=now();if(r.mode==='CALENDAR'&&r.status==='ACTIVE')materializeCalendarRecurrence(db,r,localDate(),at);db.prepare("UPDATE recurrences SET status='CANCELLED',updated_at=?,cancelled_at=? WHERE id=?").run(at,at,n);recurrenceEvent(db,n,'CANCELLED',{status:r.status},{status:'CANCELLED'},null,at);return{ok:true,recurrence:recurrencePresented(db,recurrenceRow(db,n)),changed:true};});}
function recurrence(db,action,p){if(action==='create')return recurrenceCreate(db,p);if(action==='list')return recurrenceList(db,p);if(action==='get'){const n=recurrenceId(p.id),r=recurrenceRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Recurrence R-${n} not found`,undefined,3);return{ok:true,recurrence:recurrencePresented(db,r)};}if(action==='detail')return recurrenceDetail(db,recurrenceId(p.id));if(action==='history'){const n=recurrenceId(p.id);if(!recurrenceRow(db,n))throw new AppError('NOT_FOUND',`Recurrence R-${n} not found`,undefined,3);return{ok:true,recurrence_id:`R-${n}`,events:db.prepare('SELECT * FROM recurrence_events WHERE recurrence_id=? ORDER BY id').all(n).map(x=>({id:`RE-${x.id}`,recurrence_id:`R-${x.recurrence_id}`,event_type:x.event_type,old_value:x.old_value?JSON.parse(x.old_value):null,new_value:x.new_value?JSON.parse(x.new_value):null,reason:x.reason,occurred_at:x.occurred_at}))};}if(action==='update')return recurrenceUpdate(db,p);if(action==='pause')return recurrencePause(db,p);if(action==='resume')return recurrenceResume(db,p);if(action==='cancel')return recurrenceCancel(db,p);throw new AppError('USAGE',`Unknown recurrence action: ${action}`);}

function fmtReminder(db,r){const local=localDateTimeAt(r.trigger_at),task=r.task_id===null?null:taskRow(db,r.task_id);return{id:`REM-${r.id}`,task_id:r.task_id===null?null:`T-${r.task_id}`,text:r.text??null,display_text:r.task_id===null?r.text:(task?.title??null),trigger_at:r.trigger_at,trigger_date:local.date,trigger_time:local.time,status:r.status,close_reason:r.close_reason??null,created_at:r.created_at,closed_at:r.closed_at??null};}
const REMINDER_SEND_TOKEN_PREFIX='reminder-send:';
function reminderRow(db,n){return db.prepare('SELECT * FROM reminders WHERE id=?').get(n);}
function assertReminderNotClaimed(r){if(r.claim_token!==null)throw new AppError('REMINDER_IN_FLIGHT','Reminder delivery is already in progress; retry shortly',{id:`REM-${r.id}`});}
function reminderSendInFlight(r,at){return typeof r.claim_token==='string'&&r.claim_token.startsWith(REMINDER_SEND_TOKEN_PREFIX)&&typeof r.claim_expires_at==='string'&&r.claim_expires_at>at;}
function closeLinkedReminders(db,taskId,reason,at){const rows=db.prepare("SELECT id,claim_token,claim_expires_at FROM reminders WHERE task_id=? AND status='ACTIVE' ORDER BY id").all(taskId),sending=rows.filter(r=>reminderSendInFlight(r,at));if(sending.length)throw new AppError('REMINDER_IN_FLIGHT','Reminder delivery has already started; retry the Task transition shortly',{reminder_ids:sending.map(x=>`REM-${x.id}`)});if(rows.length)db.prepare("UPDATE reminders SET status='CLOSED',close_reason=?,closed_at=?,claim_token=NULL,claimed_at=NULL,claim_expires_at=NULL WHERE task_id=? AND status='ACTIVE'").run(reason,at,taskId);return rows.map(x=>`REM-${x.id}`);}
function reminder(db,action,p){
  if(action==='list'){const limit=Number.isSafeInteger(p.limit)?Math.min(Math.max(p.limit,1),200):100,rows=db.prepare("SELECT * FROM reminders WHERE status='ACTIVE' ORDER BY trigger_at,id LIMIT ?").all(limit);return{ok:true,reminders:rows.map(x=>fmtReminder(db,x)),count:rows.length,timezone:TZ};}
  if(action==='create')return mutate(db,'reminder.create',p,()=>{const hasTask='task_id'in p,hasText='text'in p;if(hasTask===hasText)throw new AppError('INVALID_FIELD','Reminder requires exactly one of task_id or text');const triggerAt=futureReminderInstant(p.trigger_date,p.trigger_time),at=now();let taskId=null,text=null;if(hasTask){taskId=id(p.task_id,'T');const task=taskRow(db,taskId);if(!task)throw new AppError('NOT_FOUND',`Task T-${taskId} not found`,undefined,3);if(task.status!=='OPEN')throw new AppError('INVALID_STATE','Task-linked Reminder requires an OPEN Task');}else{text=required(p,'text',2000);}const n=Number(db.prepare("INSERT INTO reminders(task_id,text,trigger_at,status,close_reason,created_at,closed_at,claim_token,claimed_at,claim_expires_at) VALUES(?,?,?,'ACTIVE',NULL,?,NULL,NULL,NULL,NULL)").run(taskId,text,triggerAt,at).lastInsertRowid);return{ok:true,reminder:fmtReminder(db,reminderRow(db,n))};});
  if(action==='reschedule')return mutate(db,'reminder.reschedule',p,()=>{const n=reminderId(p.id),r=reminderRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Reminder REM-${n} not found`,undefined,3);if(r.status!=='ACTIVE')throw new AppError('INVALID_STATE','Only ACTIVE Reminder can be rescheduled');assertReminderNotClaimed(r);const triggerAt=futureReminderInstant(p.trigger_date,p.trigger_time);if(triggerAt===r.trigger_at)return{ok:true,reminder:fmtReminder(db,r),changed:false};db.prepare('UPDATE reminders SET trigger_at=? WHERE id=?').run(triggerAt,n);return{ok:true,reminder:fmtReminder(db,reminderRow(db,n)),changed:true};});
  if(action==='cancel')return mutate(db,'reminder.cancel',p,()=>{const n=reminderId(p.id),r=reminderRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Reminder REM-${n} not found`,undefined,3);if(r.status==='CLOSED')return{ok:true,reminder:fmtReminder(db,r),changed:false};assertReminderNotClaimed(r);const at=now();db.prepare("UPDATE reminders SET status='CLOSED',close_reason='USER_CANCELLED',closed_at=?,claim_token=NULL,claimed_at=NULL,claim_expires_at=NULL WHERE id=?").run(at,n);return{ok:true,reminder:fmtReminder(db,reminderRow(db,n)),changed:true};});
  throw new AppError('USAGE',`Unknown reminder action: ${action}`);
}
function reminderClaimToken(p){return required(p,'claim_token',500);}
function reminderDispatch(db,p){const token=reminderClaimToken(p),boundary=new Date(required(p,'boundary',40));if(Number.isNaN(boundary.getTime()))throw new AppError('INVALID_BOUNDARY','boundary must be a valid ISO timestamp');const at=boundary.toISOString(),expires=new Date(boundary.getTime()+5*60*1000).toISOString(),limit=Number.isSafeInteger(p.limit)?Math.min(Math.max(p.limit,1),100):100;db.exec('BEGIN IMMEDIATE;');try{db.prepare("UPDATE reminders SET claim_token=NULL,claimed_at=NULL,claim_expires_at=NULL WHERE status='ACTIVE' AND claim_token IS NOT NULL AND claim_expires_at<=?").run(at);const due=db.prepare("SELECT id FROM reminders WHERE status='ACTIVE' AND claim_token IS NULL AND trigger_at<=? ORDER BY trigger_at,id LIMIT ?").all(at,limit);for(const row of due)db.prepare("UPDATE reminders SET claim_token=?,claimed_at=?,claim_expires_at=? WHERE id=? AND status='ACTIVE' AND claim_token IS NULL").run(token,at,expires,row.id);const rows=db.prepare("SELECT * FROM reminders WHERE status='ACTIVE' AND claim_token=? ORDER BY trigger_at,id").all(token),items=rows.map(x=>fmtReminder(db,x)),message=items.map(x=>`🔔 Напоминание: ${x.display_text}`).join('\n\n');db.exec('COMMIT;');return{ok:true,claim_token:token,count:items.length,reminders:items,message};}catch(e){try{db.exec('ROLLBACK;');}catch{}throw e;}}
function reminderRenderClaim(db,p){const token=reminderClaimToken(p),rows=db.prepare("SELECT r.* FROM reminders r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.status='ACTIVE' AND r.claim_token=? AND (r.task_id IS NULL OR t.status='OPEN') ORDER BY r.trigger_at,r.id").all(token),items=rows.map(x=>fmtReminder(db,x)),message=items.map(x=>`🔔 Напоминание: ${x.display_text}`).join('\n\n');return{ok:true,claim_token:token,count:items.length,reminders:items,message};}
function reminderBeginSend(db,claimToken){const sendToken=`${REMINDER_SEND_TOKEN_PREFIX}${crypto.randomUUID()}`;db.exec('BEGIN IMMEDIATE;');try{const rows=db.prepare("SELECT r.* FROM reminders r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.status='ACTIVE' AND r.claim_token=? AND (r.task_id IS NULL OR t.status='OPEN') ORDER BY r.trigger_at,r.id").all(claimToken),items=rows.map(x=>fmtReminder(db,x)),message=items.map(x=>`🔔 Напоминание: ${x.display_text}`).join('\n\n');if(items.length){const changed=db.prepare("UPDATE reminders SET claim_token=? WHERE status='ACTIVE' AND claim_token=? AND (task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=reminders.task_id AND t.status='OPEN'))").run(sendToken,claimToken);if(Number(changed.changes)!==items.length)throw new AppError('REMINDER_SEND_DECISION_MISMATCH','Reminder send decision changed concurrently',{rendered:items.length,transitioned:Number(changed.changes)},1);}db.exec('COMMIT;');return{ok:true,claim_token:items.length?sendToken:claimToken,count:items.length,reminders:items,message};}catch(e){try{db.exec('ROLLBACK;');}catch{}throw e;}}
function reminderSettle(db,p){const token=reminderClaimToken(p);if(typeof p.delivered!=='boolean')throw new AppError('INVALID_FIELD','delivered must be boolean');const at=now();db.exec('BEGIN IMMEDIATE;');try{let affected;if(p.delivered){affected=db.prepare("SELECT id FROM reminders WHERE status='ACTIVE' AND claim_token=? ORDER BY id").all(token);db.prepare("UPDATE reminders SET status='CLOSED',close_reason='DELIVERED',closed_at=?,claim_token=NULL,claimed_at=NULL,claim_expires_at=NULL WHERE status='ACTIVE' AND claim_token=?").run(at,token);}else{affected=db.prepare("SELECT id FROM reminders WHERE status='ACTIVE' AND claim_token=? ORDER BY id").all(token);db.prepare("UPDATE reminders SET claim_token=NULL,claimed_at=NULL,claim_expires_at=NULL WHERE status='ACTIVE' AND claim_token=?").run(token);}db.exec('COMMIT;');return{ok:true,claim_token:token,delivered:p.delivered,affected:affected.map(x=>`REM-${x.id}`),count:affected.length};}catch(e){try{db.exec('ROLLBACK;');}catch{}throw e;}}

function reminderOpenClawConfigPath(){
  if(process.env.TASKCTL_ALLOW_DB_OVERRIDE==='1'&&process.env.TASKCTL_TEST_OPENCLAW_CONFIG)return path.resolve(process.env.TASKCTL_TEST_OPENCLAW_CONFIG);
  if(process.env.OPENCLAW_CONFIG_PATH)return path.resolve(process.env.OPENCLAW_CONFIG_PATH);
  return path.join(os.homedir(),'.openclaw','openclaw.json');
}
function reminderDeliveryRoute(){
  let config;
  try{config=JSON.parse(fs.readFileSync(reminderOpenClawConfigPath(),'utf8'));}catch{throw new AppError('REMINDER_ROUTE_INVALID','Reminder delivery configuration is unavailable',undefined,1);}
  const account=config?.channels?.telegram?.accounts?.tasks,bindings=Array.isArray(config?.bindings)?config.bindings:[];
  if(!account||account.enabled!==true||account.dmPolicy!=='allowlist'||!Array.isArray(account.allowFrom)||account.allowFrom.length!==1||account.groupPolicy!=='allowlist'||!Array.isArray(account.groupAllowFrom)||account.groupAllowFrom.length!==1)throw new AppError('REMINDER_ROUTE_INVALID','Reminder delivery requires one owner-only Tasks Telegram route',undefined,1);
  const target=String(account.allowFrom[0]??'').trim();
  if(!target||String(account.groupAllowFrom[0]??'').trim()!==target)throw new AppError('REMINDER_ROUTE_INVALID','Reminder delivery owner route is ambiguous',undefined,1);
  const matches=bindings.filter(x=>x?.agentId==='tasks'&&x?.match?.channel==='telegram'&&x?.match?.accountId==='tasks');
  if(matches.length!==1)throw new AppError('REMINDER_ROUTE_INVALID','Reminder delivery requires one Tasks Telegram binding',undefined,1);
  return{channel:'telegram',account:'tasks',target};
}
function reminderOpenClawBin(){
  if(process.env.TASKCTL_ALLOW_DB_OVERRIDE==='1'&&process.env.TASKCTL_TEST_OPENCLAW_BIN)return path.resolve(process.env.TASKCTL_TEST_OPENCLAW_BIN);
  return'openclaw';
}
function reminderConfirmedSend(result){
  if(!result||Array.isArray(result)||typeof result!=='object'||result.action!=='send'||result.channel!=='telegram'||result.dryRun!==false)return false;
  const messageId=result.messageId===undefined||result.messageId===null?'':String(result.messageId).trim();
  if(!messageId)return false;
  if(result.deliveryStatus==='sent')return true;
  const payload=result.payload;
  if(!payload||Array.isArray(payload)||typeof payload!=='object'||payload.ok!==true)return false;
  const payloadMessageId=payload.messageId===undefined||payload.messageId===null?'':String(payload.messageId).trim();
  return payloadMessageId!==''&&payloadMessageId===messageId;
}
function reminderDispatchSend(db){
  const claimToken=`reminder-claim:${crypto.randomUUID()}`,boundary=now();
  const claimed=reminderDispatch(db,{claim_token:claimToken,boundary,limit:100});
  if(claimed.count===0)return{ok:true,count:0,delivered:0};
  let route;
  try{route=reminderDeliveryRoute();}catch(e){reminderSettle(db,{claim_token:claimToken,delivered:false});throw e;}
  const send=reminderBeginSend(db,claimToken);
  if(send.count===0){reminderSettle(db,{claim_token:claimToken,delivered:false});return{ok:true,count:0,delivered:0,suppressed:claimed.count};}
  const args=['message','send','--channel',route.channel,'--account',route.account,'--target',route.target,'--message',send.message,'--json'];
  let child;
  try{child=spawnSync(reminderOpenClawBin(),args,{encoding:'utf8',timeout:40000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});}
  catch{throw new AppError('REMINDER_DELIVERY_UNCONFIRMED','Reminder delivery was not confirmed; claim remains retryable',{count:send.count},1);}
  if(child.error||child.signal||child.status!==0)throw new AppError('REMINDER_DELIVERY_UNCONFIRMED','Reminder delivery was not confirmed; claim remains retryable',{count:send.count},1);
  let result;
  try{result=JSON.parse(String(child.stdout??'').trim());}catch{throw new AppError('REMINDER_DELIVERY_UNCONFIRMED','Reminder delivery returned no confirmed success; claim remains retryable',{count:send.count},1);}
  if(!reminderConfirmedSend(result))throw new AppError('REMINDER_DELIVERY_UNCONFIRMED','Reminder delivery returned no confirmed success; claim remains retryable',{count:send.count},1);
  const settled=reminderSettle(db,{claim_token:send.claim_token,delivered:true});
  if(settled.count!==send.count)throw new AppError('REMINDER_SETTLEMENT_MISMATCH','Reminder delivery succeeded but exact claim settlement changed concurrently',{sent:send.count,settled:settled.count},1);
  return{ok:true,count:send.count,delivered:settled.count};
}

function createTask(db,spec,at=now()){
  const title=required(spec,'title',2000), status=spec.status??'OPEN'; if(!['OPEN','DONE'].includes(status))throw new AppError('INVALID_FIELD','New task status must be OPEN or DONE');
  const person=resolvePerson(db,spec.assignee_id??spec.assignee,{create:spec.create_assignee===true,at});
  const dueDate='due_date'in spec?date(spec.due_date):null, dueTime='due_time'in spec?time(spec.due_time):null; deadline(dueDate,dueTime);
  let projectId=null;if('project_id'in spec){if(spec.project_id===null)throw new AppError('INVALID_FIELD','project_id must be an existing ACTIVE Project identifier when supplied');projectId=requireActiveProject(db,spec.project_id).id;}
  const completed=status==='DONE'?at:null; const info=db.prepare('INSERT INTO tasks(title,assignee_id,status,due_date,due_time,created_at,completed_at,project_id) VALUES(?,?,?,?,?,?,?,?)').run(title,person.id,status,dueDate,dueTime,at,completed,projectId), taskId=Number(info.lastInsertRowid);
  event(db,taskId,'CREATED',null,JSON.stringify({title,assignee_id:`P-${person.id}`,assignee:person.display_name,status,due_date:dueDate,due_time:dueTime}),null,at);
  if(Array.isArray(spec.labels)){for(const x of spec.labels){const l=resolveLabel(db,typeof x==='object'?(x.id??x.name):x,{create:typeof x==='object'&&x.create===true,at}); db.prepare('INSERT OR IGNORE INTO task_labels(task_id,label_id) VALUES(?,?)').run(taskId,l.id);}}
  return taskPresented(db,taskRow(db,taskId));
}

function inbox(db,action,p){
  if(action==='list'){const n=Number.isSafeInteger(p.limit)?Math.min(Math.max(p.limit,1),200):50,rows=db.prepare('SELECT * FROM inbox_items ORDER BY id LIMIT ?').all(n);return{ok:true,items:rows.map(fmtInbox),count:rows.length};}
  if(action==='get'){const n=id(p.id,'I'),r=db.prepare('SELECT * FROM inbox_items WHERE id=?').get(n);if(!r)throw new AppError('NOT_FOUND',`Inbox item I-${n} not found`,undefined,3);return{ok:true,inbox:fmtInbox(r)};}
  if(action==='add')return mutate(db,'inbox.add',p,()=>{const content=required(p,'content'),capture=required(p,'capture_key',500),receipt=db.prepare('SELECT * FROM capture_receipts WHERE capture_key=?').get(capture); if(receipt){if(receipt.state==='ACTIVE'){const r=db.prepare('SELECT * FROM inbox_items WHERE id=?').get(receipt.inbox_id);if(!r)throw new AppError('INTEGRITY_ERROR','Active capture receipt has no Inbox item');return{ok:true,inbox:fmtInbox(r),duplicate_capture:true,capture_state:'ACTIVE'};}return{ok:true,inbox:null,duplicate_capture:true,capture_state:receipt.state};} const at=now(),info=db.prepare('INSERT INTO inbox_items(content,received_at,capture_key) VALUES(?,?,?)').run(content,at,capture),inboxId=Number(info.lastInsertRowid);db.prepare('INSERT INTO capture_receipts VALUES(?,?,?,?)').run(capture,inboxId,'ACTIVE',at);return{ok:true,inbox:fmtInbox(db.prepare('SELECT * FROM inbox_items WHERE id=?').get(inboxId)),duplicate_capture:false,capture_state:'ACTIVE'};});
  if(action==='discard')return mutate(db,'inbox.discard',p,()=>{const n=id(p.id,'I'),r=db.prepare('SELECT * FROM inbox_items WHERE id=?').get(n);if(!r)throw new AppError('NOT_FOUND',`Inbox item I-${n} not found`,undefined,3);db.prepare("UPDATE capture_receipts SET state='DISCARDED' WHERE capture_key=?").run(r.capture_key);db.prepare('DELETE FROM inbox_items WHERE id=?').run(n);return{ok:true,discarded:fmtInbox(r)};});
  if(action==='commit')return mutate(db,'inbox.commit',p,()=>{const n=id(p.id,'I'),r=db.prepare('SELECT * FROM inbox_items WHERE id=?').get(n);if(!r)throw new AppError('NOT_FOUND',`Inbox item I-${n} not found`,undefined,3);if(!Array.isArray(p.tasks)||p.tasks.length<1||p.tasks.length>20)throw new AppError('INVALID_FIELD','tasks must contain 1 to 20 task objects');const at=now(),tasks=p.tasks.map(x=>{if(!x||Array.isArray(x)||typeof x!=='object')throw new AppError('INVALID_FIELD','Each tasks item must be an object');return createTask(db,x,at);});db.prepare("UPDATE capture_receipts SET state='RESOLVED' WHERE capture_key=?").run(r.capture_key);db.prepare('DELETE FROM inbox_items WHERE id=?').run(n);return{ok:true,source_inbox_id:`I-${n}`,tasks};});
  throw new AppError('USAGE',`Unknown inbox action: ${action}`);
}

function taskLabels(db,n){return db.prepare('SELECT l.* FROM labels l JOIN task_labels tl ON tl.label_id=l.id WHERE tl.task_id=? ORDER BY l.display_name,l.id').all(n).map(fmtLabel);}
function taskLabelEmojis(db,n){return taskLabels(db,n).map(x=>x.emoji).filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i).slice(0,3);}
function taskPresented(db,r){const recurrence=recurrenceTaskProvenance(db,r.id),pending=pendingDeadlineChangeRequest(db,r.id);return{...fmtTask(r),label_emojis:taskLabelEmojis(db,r.id),pending_deadline_change_request:pending?fmtDeadlineChangeRequest(pending):null,...(recurrence?{recurrence}:{})};}
function originalDeadline(db,n){const r=db.prepare("SELECT new_value FROM task_events WHERE task_id=? AND event_type='CREATED' ORDER BY id LIMIT 1").get(n);if(!r)return null; try{const v=JSON.parse(r.new_value);return{due_date:v.due_date??null,due_time:v.due_time??null};}catch{return null;}}
function taskDetail(db,n){const r=taskRow(db,n);if(!r)throw new AppError('NOT_FOUND','Task T-'+n+' not found',undefined,3);const changes=db.prepare("SELECT * FROM task_events WHERE task_id=? AND event_type IN ('DUE_DATE_CHANGED','DUE_TIME_CHANGED') ORDER BY id").all(n).map(fmtEvent);const comments=db.prepare('SELECT * FROM task_comments WHERE task_id=? ORDER BY id DESC LIMIT 5').all(n).reverse().map(fmtComment);const pending=pendingDeadlineChangeRequest(db,n);return{ok:true,task:taskPresented(db,r),labels:taskLabels(db,n),original_deadline:originalDeadline(db,n),deadline_change_count:changes.length,latest_deadline_change:changes.length?changes[changes.length-1]:null,pending_deadline_change_request:pending?fmtDeadlineChangeRequest(pending):null,deadline_change_requests:deadlineRequestHistory(db,n),recent_comments:comments};}
function taskQuery(db,p,{searchMode=false}={}){
  const c=[],a=[]; let status=p.status===undefined?(searchMode?'*':'OPEN'):p.status; if(status!=='*'){if(!['OPEN','DONE','CANCELLED'].includes(status))throw new AppError('INVALID_FIELD','status must be OPEN, DONE, CANCELLED, or *');c.push('t.status=?');a.push(status);}
  if(p.assignee!==undefined||p.assignee_id!==undefined){const per=resolvePerson(db,p.assignee_id??p.assignee);c.push("EXISTS(SELECT 1 FROM contacts.people ap WHERE ap.id=t.assignee_id AND (ap.id=? OR (ap.status='MERGED' AND ap.merged_into=?)))");a.push(per.id,per.id);}
  if(p.label!==undefined){const l=resolveLabel(db,p.label);c.push('EXISTS(SELECT 1 FROM task_labels tl WHERE tl.task_id=t.id AND tl.label_id=?)');a.push(l.id);}
  if(p.view==='today'){c.push('t.due_date IS NOT NULL AND t.due_date<=?');a.push(localDate());}else if(p.view==='overdue'){c.push('(t.due_date<? OR (t.due_date=? AND t.due_time IS NOT NULL AND t.due_time<=?))');a.push(localDate(),localDate(),localTime());}else if(p.view==='no_due')c.push('t.due_date IS NULL');else if(p.view!==undefined)throw new AppError('INVALID_FIELD','view must be today, overdue, or no_due');
  if(p.due_on!==undefined){c.push('t.due_date=?');a.push(date(p.due_on));} if(p.due_until!==undefined){c.push('t.due_date IS NOT NULL AND t.due_date<=?');a.push(date(p.due_until));}
  if(p.search!==undefined){const q=ci(required(p,'search',1000)).replace(/[\\%_]/g,m=>'\\'+m),like='%'+q+'%';c.push("(task_ci(t.title) LIKE ? ESCAPE '\\' OR task_ci(p.display_name) LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM task_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.task_id=t.id AND task_ci(l.display_name) LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM task_comments tc WHERE tc.task_id=t.id AND task_ci(tc.content) LIKE ? ESCAPE '\\'))");a.push(like,like,like,like);} if(searchMode&&p.search===undefined)throw new AppError('INVALID_FIELD','task search requires search');
  const limit=Number.isSafeInteger(p.limit)?Math.min(Math.max(p.limit,1),200):(searchMode?50:100);const where=c.length?'WHERE '+c.join(' AND '):'';
  const today=localDate(), clockTime=localTime(), tomorrow=addLocalDays(today,1);
  let ordering, orderArgs;
  if(searchMode){
    ordering="CASE t.status WHEN 'OPEN' THEN 0 WHEN 'DONE' THEN 1 ELSE 2 END, CASE WHEN t.status='OPEN' AND t.due_date IS NOT NULL AND (t.due_date<? OR (t.due_date=? AND t.due_time IS NOT NULL AND t.due_time<=?)) THEN 0 WHEN t.status='OPEN' AND t.due_date IS NOT NULL THEN 1 WHEN t.status='OPEN' THEN 2 ELSE 3 END,t.due_date,t.due_time,t.id";
    orderArgs=[today,today,clockTime];
  }else if(status==='OPEN'){
    const firstLabelName="(SELECT l.display_name FROM labels l JOIN task_labels tl ON tl.label_id=l.id WHERE tl.task_id=t.id ORDER BY l.display_name,l.id LIMIT 1)";
    const firstLabelId="(SELECT l.id FROM labels l JOIN task_labels tl ON tl.label_id=l.id WHERE tl.task_id=t.id ORDER BY l.display_name,l.id LIMIT 1)";
    ordering=`CASE WHEN t.due_date IS NOT NULL AND (t.due_date<? OR (t.due_date=? AND t.due_time IS NOT NULL AND t.due_time<=?)) THEN 0 WHEN t.due_date=? THEN 1 WHEN t.due_date=? THEN 2 WHEN t.due_date IS NOT NULL THEN 3 ELSE 4 END, CASE WHEN t.due_date>? THEN t.due_date ELSE '' END, CASE WHEN ${firstLabelId} IS NULL THEN 1 ELSE 0 END, ${firstLabelName}, ${firstLabelId}, COALESCE(t.due_date,''), COALESCE(t.due_time,''), t.id`;
    orderArgs=[today,today,clockTime,today,tomorrow,tomorrow];
  }else{
    ordering="CASE WHEN t.due_date IS NOT NULL AND (t.due_date<? OR (t.due_date=? AND t.due_time IS NOT NULL AND t.due_time<=?)) THEN 0 WHEN t.due_date IS NOT NULL THEN 1 ELSE 2 END,t.due_date,t.due_time,t.id";
    orderArgs=[today,today,clockTime];
  }
  const rows=db.prepare(`SELECT t.*,p.id assignee_canonical_id,p.display_name assignee,p.is_self assignee_is_self,pr.title project_title,pr.status project_status FROM tasks t JOIN contacts.people ps ON ps.id=t.assignee_id JOIN contacts.people p ON p.id=CASE WHEN ps.status='MERGED' THEN ps.merged_into ELSE ps.id END LEFT JOIN projects pr ON pr.id=t.project_id ${where} ORDER BY ${ordering} LIMIT ?`).all(...a,...orderArgs,limit);
  if(!searchMode&&status==='OPEN'&&p.view==='today'){
    const ranked=rows.map(r=>{const personal=taskIsPersonal(db,r.id),office=personInOfficeCeo(db,r.assignee_canonical_id);const section=r.due_date<today?'OVERDUE':personal?'PERSONAL':office?'OFFICE_CEO':'TEAM';return{row:r,task:{...taskPresented(db,r),today_section:section}};});
    const rank={OVERDUE:0,OFFICE_CEO:1,TEAM:2,PERSONAL:3};
    ranked.sort((a,b)=>{const ar=rank[a.task.today_section],br=rank[b.task.today_section];if(ar!==br)return ar-br;if(a.task.today_section==='PERSONAL'){const at=a.row.due_time??'99:99',bt=b.row.due_time??'99:99';return at.localeCompare(bt)||a.row.id-b.row.id;}const byPerson=a.row.assignee.localeCompare(b.row.assignee,'ru-RU');if(byPerson)return byPerson;if(a.task.today_section==='OVERDUE')return (a.row.due_date??'').localeCompare(b.row.due_date??'')||(a.row.due_time??'').localeCompare(b.row.due_time??'')||a.row.id-b.row.id;return (a.row.due_time??'99:99').localeCompare(b.row.due_time??'99:99')||a.row.id-b.row.id;});
    return{ok:true,tasks:ranked.map(x=>x.task),count:ranked.length,local_date:today,local_time:clockTime,timezone:TZ,today_view:true};
  }
  return{ok:true,tasks:rows.map(r=>taskPresented(db,r)),count:rows.length,local_date:today,local_time:clockTime,timezone:TZ};
}
function task(db,action,p){
  if(action==='list')return taskQuery(db,p); if(action==='find'||action==='search')return taskQuery(db,p,{searchMode:true});
  if(action==='get'){const n=id(p.id,'T'),r=taskRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Task T-${n} not found`,undefined,3);return{ok:true,task:taskPresented(db,r)};}
  if(action==='detail'){return taskDetail(db,id(p.id,'T'));}
  if(action==='history'){const n=id(p.id,'T');if(!taskRow(db,n))throw new AppError('NOT_FOUND','Task T-'+n+' not found',undefined,3);return{ok:true,task_id:'T-'+n,events:db.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY id').all(n).map(fmtEvent),deadline_change_requests:deadlineRequestHistory(db,n),comments:db.prepare('SELECT * FROM task_comments WHERE task_id=? ORDER BY id').all(n).map(fmtComment)};}
  if(action==='create')return mutate(db,'task.create',p,()=>({ok:true,task:createTask(db,p)}));
  if(action==='update')return mutate(db,'task.update',p,()=>{
    const n=id(p.id,'T'),r=taskRow(db,n);if(!r)throw new AppError('NOT_FOUND','Task T-'+n+' not found',undefined,3);if(r.status!=='OPEN')throw new AppError('INVALID_STATE','Only OPEN tasks can be updated');
    const targetDate='due_date'in p?date(p.due_date):r.due_date,targetTime='due_time'in p?time(p.due_time):r.due_time;deadline(targetDate,targetTime);
    const deadlineChanged=targetDate!==r.due_date||targetTime!==r.due_time;
    const targetAssignee=('assignee'in p||'assignee_id'in p)?resolvePerson(db,p.assignee_id??p.assignee,{create:p.create_assignee===true}):null;
    const pendingRequest=deadlineChanged?pendingDeadlineChangeRequest(db,n):null;
    if(deadlineChanged&&pendingRequest)throw new AppError('DEADLINE_REQUEST_PENDING','Task has a pending Deadline Change Request; resolve it instead of changing the effective deadline directly',{task_id:'T-'+n,pending_request:fmtDeadlineChangeRequest(pendingRequest)});
    if(deadlineChanged&&(!personInOfficeCeo(db,r.assignee_canonical_id)||(targetAssignee&&!personInOfficeCeo(db,targetAssignee.id))))throw new AppError('DEADLINE_REQUEST_REQUIRED','A direct deadline change cannot create or modify an external-assignee commitment; use a reason-backed Deadline Change Request instead',{task_id:'T-'+n,pending_request:null});
    const reason=optionalString(p,'reason',2000),sets=[],vals=[],ev=[];
    if('title'in p){const v=required(p,'title',2000);if(v!==r.title){sets.push('title=?');vals.push(v);ev.push(['TITLE_CHANGED',r.title,v,null]);}}
    if(targetAssignee&&targetAssignee.id!==r.assignee_id){sets.push('assignee_id=?');vals.push(targetAssignee.id);ev.push(['ASSIGNEE_CHANGED','P-'+r.assignee_id,'P-'+targetAssignee.id,null]);}
    if('due_date'in p&&targetDate!==r.due_date){sets.push('due_date=?');vals.push(targetDate);ev.push(['DUE_DATE_CHANGED',r.due_date,targetDate,reason]);}
    if('due_time'in p&&targetTime!==r.due_time){sets.push('due_time=?');vals.push(targetTime);ev.push(['DUE_TIME_CHANGED',r.due_time,targetTime,reason]);}
    if(!sets.length)return{ok:true,task:taskPresented(db,r),changed:false};
    db.prepare('UPDATE tasks SET '+sets.join(',')+' WHERE id=?').run(...vals,n);const at=now();ev.forEach(x=>event(db,n,...x,at));return{ok:true,task:taskPresented(db,taskRow(db,n)),changed:true};
  });
  if(action==='complete')return mutate(db,'task.complete',p,()=>{const n=id(p.id,'T'),r=taskRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Task T-${n} not found`,undefined,3);const source=recurrenceForTask(db,n);if(r.status==='DONE'){const successor=source?.recurrence.mode==='AFTER_COMPLETION'?db.prepare('SELECT task_id FROM recurrence_occurrences WHERE predecessor_task_id=?').get(n):null;return{ok:true,task:taskPresented(db,r),changed:false,successor:successor?taskPresented(db,taskRow(db,successor.task_id)):null};}if(r.status!=='OPEN')throw new AppError('INVALID_STATE',`Cannot change ${r.status} task to DONE`);const at=now(),closed_deadline_request=closePendingDeadlineRequest(db,n,at);db.prepare("UPDATE tasks SET status='DONE',completed_at=? WHERE id=?").run(at,n);event(db,n,'STATUS_CHANGED',r.status,'DONE',null,at);const closed_reminders=closeLinkedReminders(db,n,'TASK_COMPLETED',at);if(process.env.TASKCTL_ALLOW_DB_OVERRIDE==='1'&&process.env.TASKCTL_TEST_RECURRENCE_FAULT==='after-complete-before-successor')throw new AppError('TEST_RECURRENCE_FAULT','Synthetic recurrence completion fault');let successor=null;if(source?.recurrence.mode==='AFTER_COMPLETION'&&source.recurrence.status==='ACTIVE')successor=afterSuccessor(db,source.recurrence,n,localDateAt(at),at).task;return{ok:true,task:taskPresented(db,taskRow(db,n)),changed:true,successor,closed_reminders,closed_deadline_request};});
  if(action==='cancel')return mutate(db,'task.cancel',p,()=>{const n=id(p.id,'T'),r=taskRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Task T-${n} not found`,undefined,3);if(r.status==='CANCELLED')return{ok:true,task:taskPresented(db,r),changed:false};if(r.status!=='OPEN')throw new AppError('INVALID_STATE',`Cannot change ${r.status} task to CANCELLED`);const at=now(),source=recurrenceForTask(db,n),closed_deadline_request=closePendingDeadlineRequest(db,n,at);db.prepare("UPDATE tasks SET status='CANCELLED',completed_at=NULL WHERE id=?").run(n);event(db,n,'STATUS_CHANGED',r.status,'CANCELLED',null,at);const closed_reminders=closeLinkedReminders(db,n,'TASK_CANCELLED',at);return{ok:true,task:taskPresented(db,taskRow(db,n)),changed:true,closed_reminders,closed_deadline_request,recurrence_resolution_required:Boolean(source?.recurrence.mode==='AFTER_COMPLETION'&&source.recurrence.status==='ACTIVE'),recurrence_id:source?`R-${source.recurrence.id}`:null};});
  throw new AppError('USAGE',`Unknown task action: ${action}`);
}

function project(db,action,p){
  if(action==='list'){
    const status=p.status??'ACTIVE';if(!['ACTIVE','DONE','CANCELLED','*'].includes(status))throw new AppError('INVALID_FIELD','status must be ACTIVE, DONE, CANCELLED, or *');
    const c=[],a=[];if(status!=='*'){c.push('status=?');a.push(status);}if(p.search!==undefined){const q=ci(required(p,'search',1000)).replace(/[\\%_]/g,m=>'\\'+m);c.push("task_ci(title) LIKE ? ESCAPE '\\'");a.push('%'+q+'%');}
    const limit=Number.isSafeInteger(p.limit)?Math.min(Math.max(p.limit,1),200):100,where=c.length?'WHERE '+c.join(' AND '):'',rows=db.prepare(`SELECT * FROM projects ${where} ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'DONE' THEN 1 ELSE 2 END,title,id LIMIT ?`).all(...a,limit);
    return{ok:true,projects:rows.map(r=>projectPresented(db,r)),count:rows.length};
  }
  if(action==='get'){
    const r=resolveProject(db,p.id),rows=db.prepare("SELECT t.*,pe.id assignee_canonical_id,pe.display_name assignee,pe.is_self assignee_is_self,pr.title project_title,pr.status project_status FROM tasks t JOIN contacts.people ps ON ps.id=t.assignee_id JOIN contacts.people pe ON pe.id=CASE WHEN ps.status='MERGED' THEN ps.merged_into ELSE ps.id END LEFT JOIN projects pr ON pr.id=t.project_id WHERE t.project_id=? ORDER BY CASE t.status WHEN 'OPEN' THEN 0 WHEN 'DONE' THEN 1 ELSE 2 END,COALESCE(t.due_date,''),COALESCE(t.due_time,''),t.id").all(r.id);
    return{ok:true,project:projectPresented(db,r),tasks:rows.map(x=>taskPresented(db,x))};
  }
  if(action==='create')return mutate(db,'project.create',p,()=>{const title=required(p,'title',2000),at=now(),n=Number(db.prepare("INSERT INTO projects(title,status,created_at,completed_at) VALUES(?,'ACTIVE',?,NULL)").run(title,at).lastInsertRowid);return{ok:true,project:projectPresented(db,db.prepare('SELECT * FROM projects WHERE id=?').get(n))};});
  if(action==='rename')return mutate(db,'project.rename',p,()=>{const r=resolveProject(db,p.id),title=required(p,'title',2000);if(r.title===title)return{ok:true,project:projectPresented(db,r),changed:false};db.prepare('UPDATE projects SET title=? WHERE id=?').run(title,r.id);return{ok:true,project:projectPresented(db,db.prepare('SELECT * FROM projects WHERE id=?').get(r.id)),changed:true};});
  if(['complete','cancel'].includes(action))return mutate(db,`project.${action}`,p,()=>{const r=resolveProject(db,p.id),target=action==='complete'?'DONE':'CANCELLED';if(r.status===target)return{ok:true,project:projectPresented(db,r),changed:false};if(r.status!=='ACTIVE')throw new AppError('INVALID_STATE',`Cannot change ${r.status} Project to ${target}`);const blockers=recurrenceProjectBlockers(db,r.id);if(blockers.length)throw new AppError('RECURRENCE_PROJECT_TARGET_CONFLICT','Project is still targeted by ACTIVE or PAUSED Recurrences',{recurrence_ids:blockers});db.prepare('UPDATE projects SET status=?,completed_at=? WHERE id=?').run(target,target==='DONE'?now():null,r.id);return{ok:true,project:projectPresented(db,db.prepare('SELECT * FROM projects WHERE id=?').get(r.id)),changed:true};});
  throw new AppError('USAGE',`Unknown project action: ${action}`);
}
function taskProject(db,action,p){
  if(action!=='set')throw new AppError('USAGE',`Unknown task-project action: ${action}`);
  return mutate(db,'task_project.set',p,()=>{if(!('project_id'in p))throw new AppError('INVALID_FIELD','project_id is required and may be a Project identifier or null');const n=id(p.task_id,'T'),r=taskRow(db,n);if(!r)throw new AppError('NOT_FOUND',`Task T-${n} not found`,undefined,3);let target=null;if(p.project_id!==null)target=projectId(p.project_id);if(r.project_id===target)return{ok:true,task:taskPresented(db,r),changed:false};if(target!==null)requireActiveProject(db,p.project_id);const previous=r.project_id===null?null:`PRJ-${r.project_id}`;db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(target,n);return{ok:true,task:taskPresented(db,taskRow(db,n)),previous_project_id:previous,changed:true};});
}

function person(db,action,p){
  if(action==='list')return{ok:true,people:db.prepare("SELECT * FROM contacts.people WHERE status='ACTIVE' ORDER BY display_name,id").all().map(fmtPerson)};
  if(action==='resolve'){const reference=required(p,'reference',500),result=contacts.resolve(db,reference,{schema:'contacts'});const matches=result.matches.map(fmtPerson);return{ok:true,reference,outcome:result.outcome,matches,count:matches.length,ambiguous:result.outcome==='AMBIGUOUS',redirected_from:result.redirected_from??null};}
  if(action==='create')return mutate(db,'person.create',p,()=>{const name=required(p,'display_name',500),result=contacts.createOrReuse(db,{display_name:name},{schema:'contacts'});if(result.outcome==='AMBIGUOUS')throw new AppError('AMBIGUOUS_PERSON','Person creation matches multiple identities',{candidates:result.matches.map(fmtPerson)});return{ok:true,person:fmtPerson(result.person),created:result.created};});
  if(action==='rename')return mutate(db,'person.rename',p,()=>{const n=id(p.id,'P'),name=required(p,'display_name',500);let row;try{row=contacts.updateFacts(db,n,{display_name:name},{schema:'contacts'});}catch(error){const code=/Canonical self/.test(error.message)?'SELF_CONFLICT':/not found/i.test(error.message)?'NOT_FOUND':'IDENTITY_CONFLICT';throw new AppError(code,error.message);}return{ok:true,person:fmtPerson(row),aliases:contacts.aliasesFor(db,row.id,'contacts').map(x=>x.alias)};});
  if(action==='alias_add'||action==='alias_remove')return mutate(db,`person.${action}`,p,()=>{const n=id(p.id,'P'),alias=required(p,'alias',500);let aliases;try{if(action==='alias_add')aliases=contacts.addAlias(db,n,alias,{schema:'contacts'});else aliases=contacts.removeAlias(db,n,alias,{schema:'contacts'});}catch(error){throw new AppError(/not found/i.test(error.message)?'NOT_FOUND':'IDENTITY_CONFLICT',error.message);}const canonical=contacts.canonicalPerson(db,n,'contacts');return{ok:true,person_id:`P-${canonical.id}`,aliases:aliases.map(x=>x.alias)};});
  if(action==='merge')return mutate(db,'person.merge',p,()=>{const from=id(p.from_id,'P'),to=id(p.into_id,'P');if(from===to)throw new AppError('INVALID_FIELD','from_id and into_id must differ');let result;try{result=contacts.merge(db,from,to,{schema:'contacts'});}catch(error){const code=/Canonical self/.test(error.message)?'SELF_CONFLICT':/not found/i.test(error.message)?'NOT_FOUND':'IDENTITY_CONFLICT';throw new AppError(code,error.message);}const canonical=contacts.canonicalPerson(db,result.person,'contacts');return{ok:true,changed:result.changed,merged_from:`P-${from}`,person:fmtPerson(canonical),aliases:contacts.aliasesFor(db,canonical.id,'contacts').map(x=>x.alias)};});
  throw new AppError('USAGE',`Unknown person action: ${action}`);
}
function label(db,action,p){
  if(action==='list')return{ok:true,labels:db.prepare('SELECT * FROM labels ORDER BY display_name,id').all().map(fmtLabel)};
  if(action==='resolve'){const m=labelsMatching(db,required(p,'reference',500));const matches=m.map(x=>({...fmtLabel(x),task_association_count:Number(db.prepare('SELECT count(*) n FROM task_labels WHERE label_id=?').get(x.id).n),recurrence_association_count:Number(db.prepare('SELECT count(*) n FROM recurrence_labels WHERE label_id=?').get(x.id).n)}));return{ok:true,reference:p.reference,matches,count:matches.length,ambiguous:matches.length>1};}
  if(action==='create')return mutate(db,'label.create',p,()=>{const name=required(p,'display_name',500),result=createOrReuseLabel(db,name);if('emoji'in p){const emoji=emojiValue(p);if(!result.created&&result.label.emoji!==emoji)throw new AppError('INVALID_STATE','Existing Label emoji must be changed with label set_emoji',{label:fmtLabel(result.label)});if(result.created)db.prepare('UPDATE labels SET emoji=? WHERE id=?').run(emoji,result.label.id);}return{ok:true,label:fmtLabel(db.prepare('SELECT * FROM labels WHERE id=?').get(result.label.id)),created:result.created};});
  if(action==='rename')return mutate(db,'label.rename',p,()=>{const n=id(p.id,'L');if(!db.prepare('SELECT 1 FROM labels WHERE id=?').get(n))throw new AppError('NOT_FOUND',`Label L-${n} not found`,undefined,3);const name=required(p,'display_name',500),conflicts=labelsMatching(db,name).filter(x=>x.id!==n);if(conflicts.length)throw new AppError('IDENTITY_CONFLICT','Label name matches another canonical Label or alias',{candidates:conflicts.map(fmtLabel)});db.prepare('UPDATE labels SET display_name=? WHERE id=?').run(name,n);return{ok:true,label:fmtLabel(db.prepare('SELECT * FROM labels WHERE id=?').get(n))};});
  if(action==='set_emoji')return mutate(db,'label.set_emoji',p,()=>{const n=id(p.id,'L'),current=db.prepare('SELECT * FROM labels WHERE id=?').get(n);if(!current)throw new AppError('NOT_FOUND',`Label L-${n} not found`,undefined,3);const emoji=emojiValue(p);if((current.emoji??null)===emoji)return{ok:true,label:fmtLabel(current),changed:false};db.prepare('UPDATE labels SET emoji=? WHERE id=?').run(emoji,n);return{ok:true,label:fmtLabel(db.prepare('SELECT * FROM labels WHERE id=?').get(n)),changed:true};});
  if(action==='alias_add'||action==='alias_remove')return mutate(db,`label.${action}`,p,()=>{const n=id(p.id,'L'),alias=required(p,'alias',500);if(!db.prepare('SELECT 1 FROM labels WHERE id=?').get(n))throw new AppError('NOT_FOUND',`Label L-${n} not found`,undefined,3);if(action==='alias_add'){const conflicts=labelsMatching(db,alias).filter(x=>x.id!==n);if(conflicts.length)throw new AppError('ALIAS_CONFLICT','Label alias matches another canonical Label',{candidates:conflicts.map(fmtLabel)});db.prepare('INSERT OR IGNORE INTO label_aliases(label_id,alias) VALUES(?,?)').run(n,alias);}else db.prepare('DELETE FROM label_aliases WHERE label_id=? AND alias=?').run(n,alias);return{ok:true,label_id:`L-${n}`,aliases:db.prepare('SELECT alias FROM label_aliases WHERE label_id=? ORDER BY alias').all(n).map(x=>x.alias)};});
  if(action==='delete')return mutate(db,'label.delete',p,()=>{const n=id(p.id,'L'),current=db.prepare('SELECT * FROM labels WHERE id=?').get(n);if(!current)throw new AppError('NOT_FOUND',`Label L-${n} not found`,undefined,3);const personalBinding=bindingRow(db,'PERSONAL_LABEL');if(personalBinding?.entity_id===n)throw new AppError('BOUND_LABEL_DELETE_FORBIDDEN','Cannot delete the Label currently bound as PERSONAL_LABEL; merge it into the replacement Label instead',{label_id:`L-${n}`});const taskAssociationCount=Number(db.prepare('SELECT count(*) n FROM task_labels WHERE label_id=?').get(n).n),affected=db.prepare('SELECT recurrence_id FROM recurrence_labels WHERE label_id=? ORDER BY recurrence_id').all(n).map(x=>({id:x.recurrence_id,before:recurrenceTemplate(db,recurrenceRow(db,x.recurrence_id))})),recurrenceAssociationCount=affected.length,at=now();db.prepare('DELETE FROM task_labels WHERE label_id=?').run(n);db.prepare('DELETE FROM recurrence_labels WHERE label_id=?').run(n);for(const x of affected)recurrenceEvent(db,x.id,'TEMPLATE_CHANGED',x.before,recurrenceTemplate(db,recurrenceRow(db,x.id)),'Canonical Label deletion',at);db.prepare('DELETE FROM label_aliases WHERE label_id=?').run(n);db.prepare('DELETE FROM labels WHERE id=?').run(n);return{ok:true,deleted:fmtLabel(current),task_association_count:taskAssociationCount,recurrence_association_count:recurrenceAssociationCount,removed_task_label_relationships:taskAssociationCount,removed_recurrence_label_relationships:recurrenceAssociationCount};});
  if(action==='merge')return mutate(db,'label.merge',p,()=>{const from=id(p.from_id,'L'),to=id(p.into_id,'L');if(from===to)throw new AppError('INVALID_FIELD','from_id and into_id must differ');const a=db.prepare('SELECT * FROM labels WHERE id=?').get(from),b=db.prepare('SELECT * FROM labels WHERE id=?').get(to);if(!a||!b)throw new AppError('NOT_FOUND','Label merge source or target not found');if(a.emoji&&b.emoji&&a.emoji!==b.emoji)throw new AppError('LABEL_EMOJI_CONFLICT','Label merge would discard conflicting emoji',{from:fmtLabel(a),into:fmtLabel(b)});const personalBinding=bindingRow(db,'PERSONAL_LABEL');const aliases=[a.display_name,...db.prepare('SELECT alias FROM label_aliases WHERE label_id=?').all(from).map(x=>x.alias)];for(const alias of aliases){const conflicts=labelsMatching(db,alias).filter(x=>x.id!==from&&x.id!==to);if(conflicts.length)throw new AppError('ALIAS_CONFLICT','Merged Label alias matches another canonical Label',{alias,candidates:conflicts.map(fmtLabel)});}for(const x of db.prepare('SELECT task_id FROM task_labels WHERE label_id=?').all(from))db.prepare('INSERT OR IGNORE INTO task_labels(task_id,label_id) VALUES(?,?)').run(x.task_id,to);const affectedRec=db.prepare('SELECT recurrence_id FROM recurrence_labels WHERE label_id=? ORDER BY recurrence_id').all(from).map(x=>({id:x.recurrence_id,before:recurrenceTemplate(db,recurrenceRow(db,x.recurrence_id))})),mergeAt=now();for(const x of affectedRec)db.prepare('INSERT OR IGNORE INTO recurrence_labels(recurrence_id,label_id) VALUES(?,?)').run(x.id,to);db.prepare('DELETE FROM recurrence_labels WHERE label_id=?').run(from);for(const x of affectedRec)recurrenceEvent(db,x.id,'TEMPLATE_CHANGED',x.before,recurrenceTemplate(db,recurrenceRow(db,x.id)),'Canonical Label merge',mergeAt);for(const alias of aliases)if(ci(alias)!==ci(b.display_name))db.prepare('INSERT OR IGNORE INTO label_aliases(label_id,alias) VALUES(?,?)').run(to,alias);if(!b.emoji&&a.emoji)db.prepare('UPDATE labels SET emoji=? WHERE id=?').run(a.emoji,to);if(personalBinding?.entity_id===from)db.prepare("UPDATE task_domain_bindings SET entity_id=?,updated_at=? WHERE binding_key='PERSONAL_LABEL'").run(to,mergeAt);db.prepare('DELETE FROM task_labels WHERE label_id=?').run(from);db.prepare('DELETE FROM label_aliases WHERE label_id=?').run(from);db.prepare('DELETE FROM labels WHERE id=?').run(from);return{ok:true,merged_from:`L-${from}`,label:fmtLabel(db.prepare('SELECT * FROM labels WHERE id=?').get(to)),aliases:db.prepare('SELECT alias FROM label_aliases WHERE label_id=? ORDER BY alias').all(to).map(x=>x.alias),personal_label_rebound:personalBinding?.entity_id===from};});
  throw new AppError('USAGE',`Unknown label action: ${action}`);
}
function term(db,action,p){
  if(action==='list')return{ok:true,terms:db.prepare('SELECT * FROM term_aliases ORDER BY alias').all()};
  if(action==='resolve'){const q=ci(required(p,'alias',500)),rows=db.prepare('SELECT * FROM term_aliases').all().filter(x=>ci(x.alias)===q);return{ok:true,matches:rows,count:rows.length,ambiguous:rows.length>1};}
  if(action==='set')return mutate(db,'term.set',p,()=>{const alias=required(p,'alias',500),expansion=required(p,'expansion',2000),at=now();const existing=db.prepare('SELECT alias FROM term_aliases').all().find(x=>ci(x.alias)===ci(alias));if(existing&&existing.alias!==alias)db.prepare('DELETE FROM term_aliases WHERE alias=?').run(existing.alias);db.prepare('INSERT INTO term_aliases(alias,expansion,created_at) VALUES(?,?,?) ON CONFLICT(alias) DO UPDATE SET expansion=excluded.expansion').run(alias,expansion,at);return{ok:true,term:db.prepare('SELECT * FROM term_aliases WHERE alias=?').get(alias)};});
  if(action==='remove')return mutate(db,'term.remove',p,()=>{const alias=required(p,'alias',500),row=db.prepare('SELECT * FROM term_aliases').all().find(x=>ci(x.alias)===ci(alias));if(row)db.prepare('DELETE FROM term_aliases WHERE alias=?').run(row.alias);return{ok:true,removed:row??null};});
  throw new AppError('USAGE',`Unknown term action: ${action}`);
}
function taskLabel(db,action,p){return mutate(db,`task_label.${action}`,p,()=>{const n=id(p.task_id,'T');if(!taskRow(db,n))throw new AppError('NOT_FOUND',`Task T-${n} not found`,undefined,3);const l=resolveLabel(db,p.label_id??p.label,{create:p.create_label===true});if(action==='add')db.prepare('INSERT OR IGNORE INTO task_labels(task_id,label_id) VALUES(?,?)').run(n,l.id);else if(action==='remove')db.prepare('DELETE FROM task_labels WHERE task_id=? AND label_id=?').run(n,l.id);else throw new AppError('USAGE',`Unknown task_label action: ${action}`);return{ok:true,task_id:`T-${n}`,labels:taskLabels(db,n),label_emojis:taskLabelEmojis(db,n)};});}
function comment(db,action,p){if(action==='list'){const n=id(p.task_id,'T');if(!taskRow(db,n))throw new AppError('NOT_FOUND',`Task T-${n} not found`,undefined,3);return{ok:true,task_id:`T-${n}`,comments:db.prepare('SELECT * FROM task_comments WHERE task_id=? ORDER BY id').all(n).map(fmtComment)};} if(action==='add')return mutate(db,'comment.add',p,()=>{const n=id(p.task_id,'T');if(!taskRow(db,n))throw new AppError('NOT_FOUND',`Task T-${n} not found`,undefined,3);const content=required(p,'content',10000),at=now(),cid=Number(db.prepare('INSERT INTO task_comments(task_id,content,created_at) VALUES(?,?,?)').run(n,content,at).lastInsertRowid);return{ok:true,comment:fmtComment(db.prepare('SELECT * FROM task_comments WHERE id=?').get(cid))};});throw new AppError('USAGE',`Unknown comment action: ${action}`);}
function refResolve(db,p){const n=Number(p.number);if(!Number.isSafeInteger(n)||n<1)throw new AppError('INVALID_FIELD','number must be a positive integer');const ctx=p.context??'auto',t=!!taskRow(db,n),i=!!db.prepare('SELECT 1 FROM inbox_items WHERE id=?').get(n);if(ctx==='task'){if(!t)throw new AppError('NOT_FOUND',`Task T-${n} not found`,undefined,3);return{ok:true,id:`T-${n}`,kind:'task'};}if(ctx==='inbox'){if(!i)throw new AppError('NOT_FOUND',`Inbox item I-${n} not found`,undefined,3);return{ok:true,id:`I-${n}`,kind:'inbox'};}if(ctx!=='auto')throw new AppError('INVALID_FIELD','context must be task, inbox, or auto');if(t&&i)throw new AppError('AMBIGUOUS_REFERENCE','Bare numeric reference matches both Task and Inbox',{task:`T-${n}`,inbox:`I-${n}`});if(t)return{ok:true,id:`T-${n}`,kind:'task'};if(i)return{ok:true,id:`I-${n}`,kind:'inbox'};throw new AppError('NOT_FOUND',`No Task or Inbox item has numeric suffix ${n}`,undefined,3);}

module.exports = {
  requireOfficeCeoGroup,
  requirePersonalLabel,
  fmtDeadlineChangeRequest,
  fmtComment,
  taskBinding,
  deadlineRequest,
  inbox,
  task,
  reminder,
  reminderDispatch,
  reminderRenderClaim,
  reminderSettle,
  reminderDispatchSend,
  recurrence,
  materializeCalendars,
  project,
  taskProject,
  person,
  label,
  term,
  taskLabel,
  comment,
  refResolve,
};
