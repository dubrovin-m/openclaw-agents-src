'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SOURCE_CONTACTS_LIB = path.resolve(__dirname, '../../../shared/contacts');
const INSTALLED_CONTACTS_LIB = path.join(os.homedir(), '.local', 'lib', 'openclaw-contacts');
const CONTACTS_LIB = fs.existsSync(path.join(SOURCE_CONTACTS_LIB, 'core.cjs')) ? SOURCE_CONTACTS_LIB : INSTALLED_CONTACTS_LIB;
const contacts = require(path.join(CONTACTS_LIB, 'core.cjs'));
const contactStore = require(path.join(CONTACTS_LIB, 'task-store.cjs'));

const IMPLEMENTATION_VERSION = '0.4.16';
const SCHEMA_VERSION = 9;
const TZ = 'Europe/Moscow';
const SELF_NAME = contacts.SELF_NAME;
const PROD_DB = path.join(os.homedir(), '.openclaw', 'data', 'tasks', 'tasks.sqlite3');
const DB_PATH = process.env.TASKCTL_ALLOW_DB_OVERRIDE === '1' && process.env.TASKCTL_DB ? path.resolve(process.env.TASKCTL_DB) : PROD_DB;
const PAYLOAD_LIMIT = 128 * 1024;

class AppError extends Error {
  constructor(code, message, details, exitCode = 2) { super(message); this.code = code; this.details = details; this.exitCode = exitCode; }
}
const die = (e) => {
  const err = e instanceof AppError ? e : new AppError('INTERNAL_ERROR', e?.message || String(e), undefined, 1);
  process.stdout.write(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) } }) + '\n');
  process.exitCode = err.exitCode;
};
const ok = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const clock = () => {
  if (process.env.TASKCTL_ALLOW_DB_OVERRIDE === '1' && process.env.TASKCTL_TEST_NOW) {
    const d = new Date(process.env.TASKCTL_TEST_NOW); if (Number.isNaN(d.getTime())) throw new AppError('INVALID_TEST_CLOCK', 'TASKCTL_TEST_NOW must be an ISO timestamp'); return d;
  }
  return new Date();
};
const now = () => clock().toISOString();
const localParts = () => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(clock()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
const localDate = () => { const p=localParts(); return `${p.year}-${p.month}-${p.day}`; };
const localTime = () => { const p=localParts(); return `${p.hour}:${p.minute}`; };
const addLocalDays = (value, days) => { const d=new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); };
const required = (o,k,max=20000) => { if(typeof o[k]!=='string'||!o[k].trim()) throw new AppError('INVALID_FIELD',`${k} must be a non-empty string`); const v=o[k].trim(); if(v.length>max) throw new AppError('INVALID_FIELD',`${k} exceeds ${max} characters`); return v; };
const optionalString = (o,k,max=20000) => { if (!(k in o) || o[k] === null) return null; if(typeof o[k]!=='string'||!o[k].trim()) throw new AppError('INVALID_FIELD',`${k} must be a non-empty string or null`); const v=o[k].trim(); if(v.length>max) throw new AppError('INVALID_FIELD',`${k} exceeds ${max} characters`); return v; };
const emojiValue = (o,k='emoji') => { if (!(k in o) || o[k] === null) return null; if(typeof o[k]!=='string'||!o[k].trim()) throw new AppError('INVALID_FIELD',`${k} must be a non-empty string or null`); const v=o[k].trim(); if(v.length>32||/[\r\n]/.test(v)) throw new AppError('INVALID_FIELD',`${k} exceeds the supported emoji presentation length`); return v; };
const date = (v) => { if(v===null) return null; if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new AppError('INVALID_DATE','due_date must be YYYY-MM-DD or null'); const d=new Date(`${v}T00:00:00Z`); if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==v) throw new AppError('INVALID_DATE','due_date must be a real calendar date'); return v; };
const time = (v) => { if(v===null) return null; if(typeof v!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new AppError('INVALID_TIME','due_time must be HH:MM (00:00-23:59) or null'); return v; };
const deadline = (d,t) => { if(t!==null&&d===null) throw new AppError('INVALID_DEADLINE','due_time requires due_date'); return {dueDate:d,dueTime:t}; };
const id = (v,prefix) => { if(Number.isSafeInteger(v)&&v>0) return v; if(typeof v==='string'){const m=v.trim().match(new RegExp(`^(?:${prefix}-)?([1-9]\\d*)$`,'i')); if(m) return Number(m[1]);} throw new AppError('INVALID_ID',`Expected ${prefix}-<number> or positive integer`); };
const projectId = (v) => { if(typeof v==='string'){const m=v.trim().match(/^PRJ-([1-9]\d*)$/i); if(m) return Number(m[1]);} throw new AppError('INVALID_ID','Expected canonical PRJ-<number> identifier'); };
const recurrenceId = (v) => { if(typeof v==='string'){const m=v.trim().match(/^R-([1-9]\d*)$/i);if(m)return Number(m[1]);}throw new AppError('INVALID_ID','Expected canonical R-<number> identifier'); };
const reminderId = (v) => { if(typeof v==='string'){const m=v.trim().match(/^REM-([1-9]\d*)$/i);if(m)return Number(m[1]);}throw new AppError('INVALID_ID','Expected canonical REM-<number> identifier'); };
const calendarDate = (v,label='date') => { if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))throw new AppError('INVALID_DATE',`${label} must be YYYY-MM-DD`);const d=new Date(`${v}T00:00:00Z`);if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==v)throw new AppError('INVALID_DATE',`${label} must be a real calendar date`);return v; };
const localDateAt = (iso) => { const d=new Date(iso);if(Number.isNaN(d.getTime()))throw new AppError('INVALID_DATE','timestamp must be valid');const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`; };
const localDateTimeAt = (iso) => { const d=new Date(iso);if(Number.isNaN(d.getTime()))throw new AppError('INVALID_DATE','timestamp must be valid');const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return{date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`}; };
function localInstant(dateValue,timeValue,label='trigger'){
  const d=calendarDate(dateValue,`${label}_date`);if(typeof timeValue!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeValue))throw new AppError('INVALID_TIME',`${label}_time must be HH:MM`);
  const [y,m,day]=d.split('-').map(Number),[hour,minute]=timeValue.split(':').map(Number),probe=new Date(Date.UTC(y,m-1,day,12));
  const zoneName=new Intl.DateTimeFormat('en-US',{timeZone:TZ,timeZoneName:'longOffset'}).formatToParts(probe).find(x=>x.type==='timeZoneName')?.value??'';
  const match=/^GMT([+-])(\d{2}):(\d{2})$/.exec(zoneName);if(!match)throw new AppError('TIMEZONE_ERROR',`Unable to resolve ${TZ} UTC offset`);
  const sign=match[1]==='-'?-1:1,offset=sign*(Number(match[2])*60+Number(match[3])),instant=new Date(Date.UTC(y,m-1,day,hour,minute)-offset*60000),roundTrip=localDateTimeAt(instant.toISOString());
  if(roundTrip.date!==d||roundTrip.time!==timeValue)throw new AppError('INVALID_TIME',`${label} is not a valid ${TZ} local time`);
  return instant.toISOString();
}
function futureReminderInstant(dateValue,timeValue){const instant=localInstant(dateValue,timeValue,'trigger');if(Date.parse(instant)<=clock().getTime())throw new AppError('REMINDER_TIME_PASSED','Reminder trigger must be in the future',{timezone:TZ,local_date:localDate(),local_time:localTime()});return instant;}
const addLocalMonths = (value,months) => { const [y,m,d]=value.split('-').map(Number),z=m-1+months,ty=y+Math.floor(z/12),tm=((z%12)+12)%12+1,last=new Date(Date.UTC(ty,tm,0)).getUTCDate(),day=Math.min(d,last);return `${String(ty).padStart(4,'0')}-${String(tm).padStart(2,'0')}-${String(day).padStart(2,'0')}`; };
const dayDiff = (a,b) => Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);
const weekday = (value) => { const d=new Date(`${value}T00:00:00Z`).getUTCDay();return d===0?7:d; };
const positiveInt = (v,label) => { if(!Number.isSafeInteger(v)||v<1)throw new AppError('INVALID_FIELD',`${label} must be a positive integer`);return v; };
function exactKeys(value,allowed,label){if(!value||Array.isArray(value)||typeof value!=='object')throw new AppError('INVALID_FIELD',`${label} must be an object`);const extra=Object.keys(value).filter(k=>!allowed.includes(k));if(extra.length)throw new AppError('INVALID_FIELD',`${label} contains unsupported fields`,{fields:extra});return value;}
function normalizeRule(mode,value){
  if(mode==='CALENDAR'){
    const v=exactKeys(value,['kind','interval','start_date','weekdays','day','month'],'rule'),kind=v.kind,start=calendarDate(v.start_date,'rule.start_date');
    if(kind==='DAYS'){if(Object.keys(v).some(k=>!['kind','interval','start_date'].includes(k)))throw new AppError('INVALID_FIELD','DAYS rule contains unsupported fields');return{kind,interval:positiveInt(v.interval,'rule.interval'),start_date:start};}
    if(kind==='WEEKS'){if(Object.keys(v).some(k=>!['kind','interval','start_date','weekdays'].includes(k))||!Array.isArray(v.weekdays)||!v.weekdays.length)throw new AppError('INVALID_FIELD','WEEKS rule requires selected weekdays');const days=[...new Set(v.weekdays.map(x=>positiveInt(x,'rule.weekday')))].sort((a,b)=>a-b);if(days.some(x=>x>7)||!days.includes(weekday(start)))throw new AppError('INVALID_FIELD','WEEKS start_date must be one selected weekday');return{kind,interval:positiveInt(v.interval,'rule.interval'),weekdays:days,start_date:start};}
    if(kind==='MONTHS'){if(Object.keys(v).some(k=>!['kind','interval','start_date','day'].includes(k)))throw new AppError('INVALID_FIELD','MONTHS rule contains unsupported fields');const day=positiveInt(v.day,'rule.day');if(day>28||Number(start.slice(8,10))!==day)throw new AppError('INVALID_FIELD','MONTHS day must be 1..28 and match start_date');return{kind,interval:positiveInt(v.interval,'rule.interval'),day,start_date:start};}
    if(kind==='YEARLY'){if(Object.keys(v).some(k=>!['kind','start_date','month','day'].includes(k)))throw new AppError('INVALID_FIELD','YEARLY rule contains unsupported fields');const month=positiveInt(v.month,'rule.month'),day=positiveInt(v.day,'rule.day');if(month>12||calendarDate(`${start.slice(0,4)}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,'rule month/day').slice(5)!==start.slice(5))throw new AppError('INVALID_FIELD','YEARLY month/day must be valid and match start_date');return{kind,month,day,start_date:start};}
    throw new AppError('INVALID_FIELD','Unsupported CALENDAR rule kind');
  }
  if(mode==='AFTER_COMPLETION'){
    const v=exactKeys(value,['interval','unit'],'rule'),unit=v.unit;if(!['DAYS','WEEKS','MONTHS'].includes(unit))throw new AppError('INVALID_FIELD','AFTER_COMPLETION unit must be DAYS, WEEKS, or MONTHS');return{interval:positiveInt(v.interval,'rule.interval'),unit};
  }
  throw new AppError('INVALID_FIELD','mode must be CALENDAR or AFTER_COMPLETION');
}
function calendarEligible(rule,value){
  if(value<rule.start_date)return false;
  if(rule.kind==='DAYS')return dayDiff(rule.start_date,value)%rule.interval===0;
  if(rule.kind==='WEEKS')return Math.floor(dayDiff(rule.start_date,value)/7)%rule.interval===0&&rule.weekdays.includes(weekday(value));
  if(rule.kind==='MONTHS'){const [sy,sm]=rule.start_date.split('-').map(Number),[y,m,d]=value.split('-').map(Number),delta=(y-sy)*12+(m-sm);return delta>=0&&delta%rule.interval===0&&d===rule.day;}
  if(rule.kind==='YEARLY'){const [sy]=rule.start_date.split('-').map(Number),[y,m,d]=value.split('-').map(Number);return y>=sy&&m===rule.month&&d===rule.day;}
  return false;
}
function afterDueDate(anchor,rule){if(rule.unit==='DAYS')return addLocalDays(anchor,rule.interval);if(rule.unit==='WEEKS')return addLocalDays(anchor,rule.interval*7);return addLocalMonths(anchor,rule.interval);}
const payload = (requiredPayload=true) => { const raw=process.env.TASKCTL_PAYLOAD; if(!raw){if(requiredPayload) throw new AppError('PAYLOAD_REQUIRED','TASKCTL_PAYLOAD is required'); return {};} if(Buffer.byteLength(raw)>PAYLOAD_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE',`TASKCTL_PAYLOAD exceeds ${PAYLOAD_LIMIT} bytes`); let v; try{v=JSON.parse(raw);}catch{throw new AppError('INVALID_JSON','TASKCTL_PAYLOAD must be valid JSON');} if(!v||Array.isArray(v)||typeof v!=='object') throw new AppError('INVALID_PAYLOAD','TASKCTL_PAYLOAD must be a JSON object'); return v; };
const stable = (v) => v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(stable).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
const hash = (v) => crypto.createHash('sha256').update(stable(v)).digest('hex');
const ci = (s) => String(s).normalize('NFKC').toLocaleLowerCase('ru-RU');

module.exports = {
  fs, os, path, crypto, spawnSync, DatabaseSync,
  contacts, contactStore,
  IMPLEMENTATION_VERSION, SCHEMA_VERSION, TZ, SELF_NAME, PROD_DB, DB_PATH, PAYLOAD_LIMIT,
  AppError, die, ok, clock, now, localParts, localDate, localTime, addLocalDays,
  required, optionalString, emojiValue, date, time, deadline, id, projectId, recurrenceId, reminderId,
  calendarDate, localDateAt, localDateTimeAt, localInstant, futureReminderInstant,
  addLocalMonths, dayDiff, weekday, positiveInt, exactKeys, normalizeRule, calendarEligible, afterDueDate,
  payload, stable, hash, ci,
};
