'use strict';

const { IMPLEMENTATION_VERSION, SCHEMA_VERSION, TZ, DB_PATH, AppError, payload, ok, die } = require('./runtime.cjs');
const { openDb, healthSnapshot } = require('./database.cjs');
const { reviewSnapshot, managementReviewSnapshot } = require('./reviews.cjs');
const {
  taskBinding, deadlineRequest, inbox, task, reminder, reminderDispatch, reminderRenderClaim, reminderSettle,
  recurrence, materializeCalendars, reminderDispatchSend, project, taskProject, person, label, term, taskLabel, comment, refResolve,
} = require('./domain.cjs');

function run(){
  let db;
  try{
  const [scope,action]=process.argv.slice(2),hiddenMaterialize=scope==='recurrence'&&action==='materialize',hiddenReminderDispatchSend=scope==='reminder-internal'&&action==='dispatch-send',p=payload(!['init','health'].includes(scope)&&!hiddenMaterialize&&!hiddenReminderDispatchSend);
  if(scope==='review'&&action==='snapshot')ok(reviewSnapshot(p));
  else if(scope==='review'&&action==='management-snapshot')ok(managementReviewSnapshot(p));
  else if(hiddenMaterialize){db=openDb();db.exec('BEGIN IMMEDIATE;');try{const result=materializeCalendars(db);db.exec('COMMIT;');ok(result);}catch(e){try{db.exec('ROLLBACK;');}catch{}throw e;}}
  else if(hiddenReminderDispatchSend){db=openDb();ok(reminderDispatchSend(db));}
  else if(scope==='health')ok(healthSnapshot());
  else{
    db=openDb();
    if(scope==='init')ok({ok:true,implementation_version:IMPLEMENTATION_VERSION,schema_version:SCHEMA_VERSION,database:DB_PATH,timezone:TZ});
    else if(scope==='config')ok(taskBinding(db,action,p)); else if(scope==='deadline-request')ok(deadlineRequest(db,action,p)); else if(scope==='inbox')ok(inbox(db,action,p)); else if(scope==='task')ok(task(db,action,p)); else if(scope==='reminder')ok(reminder(db,action,p)); else if(scope==='reminder-internal'&&action==='dispatch')ok(reminderDispatch(db,p)); else if(scope==='reminder-internal'&&action==='render')ok(reminderRenderClaim(db,p)); else if(scope==='reminder-internal'&&action==='settle')ok(reminderSettle(db,p)); else if(scope==='recurrence')ok(recurrence(db,action,p)); else if(scope==='project')ok(project(db,action,p)); else if(scope==='task-project')ok(taskProject(db,action,p)); else if(scope==='person')ok(person(db,action,p)); else if(scope==='label')ok(label(db,action,p)); else if(scope==='term')ok(term(db,action,p)); else if(scope==='task-label')ok(taskLabel(db,action,p)); else if(scope==='comment')ok(comment(db,action,p)); else if(scope==='ref'&&action==='resolve')ok(refResolve(db,p)); else throw new AppError('USAGE','Usage: taskctl <init|health|config|deadline-request|inbox|task|reminder|recurrence|project|task-project|person|label|term|task-label|comment|ref> ...');
  }
}catch(e){die(e);}finally{try{db?.close();}catch{}}

}

module.exports = { run };
