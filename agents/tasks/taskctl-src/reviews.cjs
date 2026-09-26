'use strict';

const { fs, contacts, contactStore, IMPLEMENTATION_VERSION, SCHEMA_VERSION, TZ, AppError, required, localDateAt, addLocalDays } = require('./runtime.cjs');
const { openReadDb } = require('./database.cjs');
const { fmtComment, fmtDeadlineChangeRequest, requireOfficeCeoGroup, requirePersonalLabel } = require('./domain.cjs');

function reviewSnapshot(p){
  const raw=required(p,'boundary',40),instant=new Date(raw);
  if(Number.isNaN(instant.getTime()))throw new AppError('INVALID_BOUNDARY','boundary must be a valid ISO timestamp');
  const boundary=instant.toISOString(),db=openReadDb(); let inTx=false;
  try{
    const version=Number(db.prepare('PRAGMA user_version').get().user_version);
    if(version!==SCHEMA_VERSION)throw new AppError('UNSUPPORTED_SCHEMA',`Daily Review requires schema ${SCHEMA_VERSION}; found ${version}`);
    const contactsPath=contactStore.contactsDbPath();if(!fs.existsSync(contactsPath))throw new AppError('CONTACTS_NOT_FOUND','Contacts database is missing');
    contactStore.attachContacts(db,contactsPath);
    const contactsVersion=Number(db.prepare('PRAGMA contacts.user_version').get().user_version);
    if(contactsVersion!==contacts.CONTACT_SCHEMA_VERSION)throw new AppError('UNSUPPORTED_CONTACTS_SCHEMA',`Daily Review requires Contacts schema ${contacts.CONTACT_SCHEMA_VERSION}; found ${contactsVersion}`);
    db.exec('PRAGMA query_only=ON;');
    db.exec('BEGIN;'); inTx=true;
    const officeGroup=requireOfficeCeoGroup(db),personalLabel=requirePersonalLabel(db);
    const inboxCount=Number(db.prepare('SELECT count(*) n FROM inbox_items WHERE received_at<=?').get(boundary).n);
    const rows=db.prepare(`SELECT t.id,t.title,p.id assignee_canonical_id,p.display_name assignee,t.due_date,t.due_time,t.project_id,pr.title project_title,pr.status project_status,t.created_at FROM tasks t JOIN contacts.people ps ON ps.id=t.assignee_id JOIN contacts.people p ON p.id=CASE WHEN ps.status='MERGED' THEN ps.merged_into ELSE ps.id END LEFT JOIN projects pr ON pr.id=t.project_id WHERE t.status='OPEN' AND t.created_at<=? ORDER BY t.id`).all(boundary);
    const labelRows=db.prepare(`SELECT tl.task_id,l.id,l.display_name,l.emoji FROM task_labels tl JOIN labels l ON l.id=tl.label_id JOIN tasks t ON t.id=tl.task_id WHERE t.status='OPEN' AND t.created_at<=? ORDER BY tl.task_id,l.display_name,l.id`).all(boundary);
    const labels=new Map();
    for(const row of labelRows){const list=labels.get(row.task_id)??[];list.push({id:`L-${row.id}`,display_name:row.display_name,emoji:row.emoji??null});labels.set(row.task_id,list);}
    const pendingRows=db.prepare("SELECT * FROM deadline_change_requests WHERE status='PENDING' ORDER BY task_id,id").all(),pending=new Map(pendingRows.map(row=>[row.task_id,row]));
    const tasks=rows.map(row=>({
      id:`T-${row.id}`,title:row.title,assignee:row.assignee,due_date:row.due_date??null,due_time:row.due_time??null,
      project_id:row.project_id===null?null:`PRJ-${row.project_id}`,project_title:row.project_title??null,project_status:row.project_status??null,
      created_at:row.created_at,labels:labels.get(row.id)??[],
      office_ceo:contacts.personInGroup(db,officeGroup.id,row.assignee_canonical_id,'contacts'),
      personal:Boolean((labels.get(row.id)??[]).some(label=>label.id===`L-${personalLabel.id}`)),
      pending_deadline_change_request:pending.has(row.id)?fmtDeadlineChangeRequest(pending.get(row.id)):null,
    }));
    db.exec('COMMIT;'); inTx=false;
    return{ok:true,implementation_version:IMPLEMENTATION_VERSION,schema_version:SCHEMA_VERSION,boundary,inbox_count:inboxCount,tasks};
  }catch(e){if(inTx){try{db.exec('ROLLBACK;');}catch{}}throw e;}finally{db.close();}
}

function localMidnightIso(value){
  const [year,month,day]=value.split('-').map(Number),target=Date.UTC(year,month-1,day,0,0,0);let guess=target;
  for(let i=0;i<4;i+=1){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));const represented=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));const delta=target-represented;if(delta===0)break;guess+=delta;}
  const iso=new Date(guess).toISOString(),parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  if(`${parts.year}-${parts.month}-${parts.day}`!==value||parts.hour!=='00'||parts.minute!=='00')throw new AppError('TIMEZONE_ERROR',`Cannot resolve ${value} midnight in ${TZ}`);return iso;
}
function managementReviewSnapshot(p){
  const raw=required(p,'boundary',40),instant=new Date(raw);
  if(Number.isNaN(instant.getTime()))throw new AppError('INVALID_BOUNDARY','boundary must be a valid ISO timestamp');
  const boundary=instant.toISOString(),reportDate=localDateAt(boundary),nextDate=addLocalDays(reportDate,1),dayStart=localMidnightIso(reportDate),dayEnd=localMidnightIso(nextDate),db=openReadDb();let inTx=false;
  try{
    const version=Number(db.prepare('PRAGMA user_version').get().user_version);
    if(version!==SCHEMA_VERSION)throw new AppError('UNSUPPORTED_SCHEMA',`Management Review requires schema ${SCHEMA_VERSION}; found ${version}`);
    const contactsPath=contactStore.contactsDbPath();if(!fs.existsSync(contactsPath))throw new AppError('CONTACTS_NOT_FOUND','Contacts database is missing');
    contactStore.attachContacts(db,contactsPath);
    const contactsVersion=Number(db.prepare('PRAGMA contacts.user_version').get().user_version);
    if(contactsVersion!==contacts.CONTACT_SCHEMA_VERSION)throw new AppError('UNSUPPORTED_CONTACTS_SCHEMA',`Management Review requires Contacts schema ${contacts.CONTACT_SCHEMA_VERSION}; found ${contactsVersion}`);
    db.exec('PRAGMA query_only=ON;');
    db.exec('BEGIN;');inTx=true;
    const officeGroup=requireOfficeCeoGroup(db);
    const personJoin=" JOIN contacts.people ps ON ps.id=t.assignee_id JOIN contacts.people p ON p.id=CASE WHEN ps.status='MERGED' THEN ps.merged_into ELSE ps.id END";
    const completedRaw=db.prepare(`SELECT t.id,t.title,p.id assignee_canonical_id,p.display_name assignee,t.completed_at FROM tasks t${personJoin} WHERE t.status='DONE' AND t.completed_at>=? AND t.completed_at<? AND t.completed_at<=? ORDER BY t.id`).all(dayStart,dayEnd,boundary);
    const dueRaw=db.prepare(`SELECT t.id,t.title,p.id assignee_canonical_id,p.display_name assignee,t.due_date,t.due_time FROM tasks t${personJoin} WHERE t.status='OPEN' AND t.created_at<=? AND t.due_date IS NOT NULL AND t.due_date<=? ORDER BY t.id`).all(boundary,reportDate);
    const outsideOffice=row=>!contacts.personInGroup(db,officeGroup.id,row.assignee_canonical_id,'contacts');
    const completed=completedRaw.filter(outsideOffice).map(row=>({id:`T-${row.id}`,title:row.title,assignee_id:`P-${row.assignee_canonical_id}`,assignee:row.assignee,completed_at:row.completed_at}));
    const notCompleted=dueRaw.filter(outsideOffice).map(row=>{
      const pending=db.prepare("SELECT * FROM deadline_change_requests WHERE task_id=? AND status='PENDING' AND created_at<=? ORDER BY id DESC LIMIT 1").get(row.id,boundary);
      const comments=db.prepare('SELECT * FROM task_comments WHERE task_id=? AND created_at<=? ORDER BY id DESC LIMIT 5').all(row.id,boundary).reverse().map(fmtComment);
      return{id:`T-${row.id}`,title:row.title,assignee_id:`P-${row.assignee_canonical_id}`,assignee:row.assignee,due_date:row.due_date,due_time:row.due_time??null,pending_deadline_change_request:pending?fmtDeadlineChangeRequest(pending):null,comments};
    });
    completed.sort((a,b)=>a.assignee.localeCompare(b.assignee,'ru-RU')||a.completed_at.localeCompare(b.completed_at)||a.id.localeCompare(b.id));
    notCompleted.sort((a,b)=>a.assignee.localeCompare(b.assignee,'ru-RU')||a.due_date.localeCompare(b.due_date)||(a.due_time??'').localeCompare(b.due_time??'')||a.id.localeCompare(b.id));
    db.exec('COMMIT;');inTx=false;
    return{ok:true,implementation_version:IMPLEMENTATION_VERSION,schema_version:SCHEMA_VERSION,boundary,local_date:reportDate,timezone:TZ,office_ceo_group_id:`PG-${officeGroup.id}`,completed_count:completed.length,not_completed_count:notCompleted.length,completed,not_completed:notCompleted};
  }catch(e){if(inTx){try{db.exec('ROLLBACK;');}catch{}}throw e;}finally{db.close();}
}


module.exports = { reviewSnapshot, managementReviewSnapshot };
