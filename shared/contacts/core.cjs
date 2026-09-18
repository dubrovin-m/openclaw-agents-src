'use strict';

const crypto = require('node:crypto');

const CONTACT_SCHEMA_VERSION = 2;
const SELF_NAME = 'Дубровин М.';
const STATUS_ACTIVE = 'ACTIVE';
const STATUS_MERGED = 'MERGED';

const ci = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU');
const stable = (v) => v === null || typeof v !== 'object'
  ? JSON.stringify(v)
  : Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
const requestHash = (v) => crypto.createHash('sha256').update(stable(v)).digest('hex');
const now = () => new Date().toISOString();
const schemaName = (value = 'main') => {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new Error('Invalid SQLite schema name');
  return value;
};
const table = (schema, name) => `${schemaName(schema)}.${name}`;
const personNumber = (value) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const m = typeof value === 'string' ? value.trim().match(/^(?:P-)?([1-9]\d*)$/i) : null;
  if (m) return Number(m[1]);
  throw new Error('Expected P-<number> or positive integer');
};

function schemaSql(schema = 'main') {
  const s = schemaName(schema);
  return [
    `CREATE TABLE IF NOT EXISTS ${s}.people(id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL CHECK(length(trim(display_name))>0), organization TEXT, title TEXT, is_self INTEGER NOT NULL DEFAULT 0 CHECK(is_self IN (0,1)), status TEXT NOT NULL CHECK(status IN ('ACTIVE','MERGED')), merged_into INTEGER REFERENCES people(id) ON DELETE RESTRICT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK((status='ACTIVE' AND merged_into IS NULL) OR (status='MERGED' AND merged_into IS NOT NULL AND merged_into<>id))) STRICT;`,
    `CREATE TABLE IF NOT EXISTS ${s}.person_aliases(person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT, alias TEXT NOT NULL CHECK(length(trim(alias))>0), created_at TEXT NOT NULL, PRIMARY KEY(person_id,alias)) STRICT;`,
    `CREATE TABLE IF NOT EXISTS ${s}.important_dates(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT, type TEXT NOT NULL CHECK(type IN ('BIRTHDAY','ANNIVERSARY','OTHER')), year INTEGER CHECK(year IS NULL OR (year BETWEEN 1000 AND 9999)), month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12), day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31), annual INTEGER NOT NULL CHECK(annual IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(annual=1 OR year IS NOT NULL)) STRICT;`,
    `CREATE TABLE IF NOT EXISTS ${s}.important_date_reminders(id INTEGER PRIMARY KEY AUTOINCREMENT, important_date_id INTEGER NOT NULL REFERENCES important_dates(id) ON DELETE CASCADE, offset_value INTEGER NOT NULL CHECK(offset_value>=0), offset_unit TEXT NOT NULL CHECK(offset_unit IN ('DAYS','WEEKS','MONTHS')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(important_date_id,offset_value,offset_unit)) STRICT;`,
    `CREATE TABLE IF NOT EXISTS ${s}.important_date_deliveries(reminder_id INTEGER NOT NULL REFERENCES important_date_reminders(id) ON DELETE CASCADE, occurrence_key TEXT NOT NULL CHECK(length(occurrence_key)=10), status TEXT NOT NULL CHECK(status IN ('CLAIMED','DELIVERED')), claim_token TEXT, claimed_at TEXT, claim_expires_at TEXT, delivered_at TEXT, PRIMARY KEY(reminder_id,occurrence_key), CHECK((status='CLAIMED' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL AND delivered_at IS NULL) OR (status='DELIVERED' AND delivered_at IS NOT NULL))) STRICT;`,
    `CREATE TABLE IF NOT EXISTS ${s}.operation_results(operation_key TEXT PRIMARY KEY, operation_type TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${s}.idx_people_single_self ON people(is_self) WHERE is_self=1;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${s}.idx_important_dates_single_birthday ON important_dates(person_id,type) WHERE type='BIRTHDAY';`,
    `CREATE INDEX IF NOT EXISTS ${s}.idx_people_status ON people(status,id);`,
    `CREATE INDEX IF NOT EXISTS ${s}.idx_person_aliases_alias ON person_aliases(alias);`,
    `CREATE INDEX IF NOT EXISTS ${s}.idx_important_dates_person ON important_dates(person_id,type,month,day);`,
    `CREATE INDEX IF NOT EXISTS ${s}.idx_important_date_reminders_date ON important_date_reminders(important_date_id,id);`,
    `CREATE INDEX IF NOT EXISTS ${s}.idx_important_date_deliveries_claim ON important_date_deliveries(status,claim_token,claim_expires_at);`,
  ].join('\n');
}

function schemaVersion(db, schema = 'main') {
  const s = schemaName(schema);
  return Number(db.prepare(`PRAGMA ${s}.user_version`).get().user_version);
}

function requireSchema(db, schema = 'main') {
  const s = schemaName(schema);
  const version = schemaVersion(db,s);
  if (version !== CONTACT_SCHEMA_VERSION) throw new Error(`Unsupported Contacts schema version ${version}`);
  db.exec(schemaSql(s));
}

function ensureSchema(db, schema = 'main', options = {}) {
  const s = schemaName(schema);
  const version = schemaVersion(db,s);
  if (![0,1,CONTACT_SCHEMA_VERSION].includes(version)) throw new Error(`Unsupported Contacts schema version ${version}`);
  if (version === CONTACT_SCHEMA_VERSION) {
    db.exec(schemaSql(s));
    return;
  }
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(schemaSql(s));
    if (version === 1 && options.fault === 'after-important-date-ddl') throw new Error('Synthetic Contacts migration fault');
    db.exec(`PRAGMA ${s}.user_version=${CONTACT_SCHEMA_VERSION}`);
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    throw error;
  }
}

function rawPerson(db, id, schema = 'main') {
  return db.prepare(`SELECT * FROM ${table(schema, 'people')} WHERE id=?`).get(personNumber(id)) ?? null;
}

function canonicalPerson(db, value, schema = 'main') {
  let row = typeof value === 'object' && value !== null ? value : rawPerson(db, value, schema);
  if (!row) return null;
  const seen = new Set();
  while (row.status === STATUS_MERGED) {
    if (seen.has(row.id)) throw new Error('Person merge cycle detected');
    seen.add(row.id);
    row = rawPerson(db, row.merged_into, schema);
    if (!row) throw new Error('Merged Person target is missing');
  }
  if (row.status !== STATUS_ACTIVE) throw new Error('Canonical Person is not ACTIVE');
  return row;
}

function formatPerson(row, extra = {}) {
  if (!row) return null;
  return {
    id: `P-${row.id}`,
    display_name: row.display_name,
    organization: row.organization ?? null,
    title: row.title ?? null,
    is_self: Boolean(row.is_self),
    status: row.status,
    merged_into: row.merged_into == null ? null : `P-${row.merged_into}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

function canonicalSurnameKey(displayName) {
  const parts = String(displayName ?? '').trim().split(/\s+/u);
  if (parts.length < 2 || !parts.slice(1).every((x) => /^(?:\p{L}\.){1,3}$/u.test(x))) return null;
  return ci(parts[0]);
}

function contextMatches(row, context = {}) {
  if (context.organization != null && ci(row.organization) !== ci(context.organization)) return false;
  if (context.title != null && ci(row.title) !== ci(context.title)) return false;
  return true;
}

function canonicalizeCandidates(db, rows, schema = 'main', context = {}) {
  const out = new Map();
  for (const raw of rows) {
    const canonical = canonicalPerson(db, raw, schema);
    if (!canonical || !contextMatches(canonical, context)) continue;
    out.set(canonical.id, canonical);
  }
  return [...out.values()];
}

function matchingPeople(db, reference, options = {}) {
  const schema = options.schema ?? 'main';
  const q = ci(reference);
  const people = db.prepare(`SELECT * FROM ${table(schema, 'people')}`).all();
  const exact = people.filter((row) => ci(row.display_name) === q);
  const aliasRows = db.prepare(`SELECT a.alias,p.* FROM ${table(schema, 'person_aliases')} a JOIN ${table(schema, 'people')} p ON p.id=a.person_id`).all();
  const aliases = aliasRows.filter((row) => ci(row.alias) === q);
  let result = canonicalizeCandidates(db, [...exact, ...aliases], schema, options);
  if (result.length || options.allowSurname === false) return result;
  const raw = String(reference ?? '').trim();
  if (!raw || /\s/u.test(raw)) return [];
  result = canonicalizeCandidates(db, people.filter((row) => canonicalSurnameKey(row.display_name) === q), schema, options);
  return result;
}

function resolve(db, reference, options = {}) {
  const schema = options.schema ?? 'main';
  if (Number.isSafeInteger(reference) || (typeof reference === 'string' && /^(?:P-)?[1-9]\d*$/i.test(reference.trim()))) {
    const raw = rawPerson(db, reference, schema);
    if (!raw) return { outcome: 'NOT_FOUND', matches: [] };
    const canonical = canonicalPerson(db, raw, schema);
    if (!contextMatches(canonical, options)) return { outcome: 'NOT_FOUND', matches: [] };
    return { outcome: 'MATCH', matches: [canonical], redirected_from: raw.id === canonical.id ? null : `P-${raw.id}` };
  }
  const referenceText = String(reference ?? '').trim();
  if (!referenceText) return { outcome: 'NOT_FOUND', matches: [] };
  const matches = matchingPeople(db, referenceText, options);
  if (matches.length === 1) return { outcome: 'MATCH', matches };
  if (matches.length > 1) return { outcome: 'AMBIGUOUS', matches };
  return { outcome: 'NOT_FOUND', matches: [] };
}

function aliasesFor(db, id, schema = 'main') {
  return db.prepare(`SELECT alias,created_at FROM ${table(schema, 'person_aliases')} WHERE person_id=? ORDER BY alias`).all(personNumber(id));
}

function createOrReuse(db, input, options = {}) {
  const schema = options.schema ?? 'main';
  const displayName = String(input.display_name ?? '').trim();
  if (!displayName) throw new Error('display_name must be a non-empty string');
  const matches = matchingPeople(db, displayName, { ...input, schema, allowSurname: false });
  if (matches.length > 1) return { outcome: 'AMBIGUOUS', matches };
  if (matches.length === 1) return { outcome: 'MATCH', person: matches[0], created: false };
  const at = options.at ?? now();
  const organization = input.organization == null ? null : String(input.organization).trim() || null;
  const title = input.title == null ? null : String(input.title).trim() || null;
  const isSelf = input.is_self === true ? 1 : 0;
  const info = db.prepare(`INSERT INTO ${table(schema, 'people')}(display_name,organization,title,is_self,status,merged_into,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?)`)
    .run(displayName, organization, title, isSelf, STATUS_ACTIVE, at, at);
  return { outcome: 'MATCH', person: rawPerson(db, Number(info.lastInsertRowid), schema), created: true };
}

function updateFacts(db, id, patch, options = {}) {
  const schema = options.schema ?? 'main';
  const current = canonicalPerson(db, id, schema);
  if (!current) throw new Error(`Person P-${personNumber(id)} not found`);
  const next = {
    display_name: patch.display_name == null ? current.display_name : String(patch.display_name).trim(),
    organization: Object.hasOwn(patch, 'organization') ? (patch.organization == null ? null : String(patch.organization).trim() || null) : current.organization,
    title: Object.hasOwn(patch, 'title') ? (patch.title == null ? null : String(patch.title).trim() || null) : current.title,
  };
  if (!next.display_name) throw new Error('display_name must be non-empty');
  if (current.is_self && next.display_name !== SELF_NAME) throw new Error(`Canonical self identity must remain ${SELF_NAME}`);
  const oldName = current.display_name;
  if (ci(oldName) !== ci(next.display_name)) {
    const conflicts = matchingPeople(db,next.display_name,{schema,allowSurname:false}).filter((row) => row.id !== current.id);
    if (conflicts.length) throw new Error('display_name matches another canonical Person or alias');
  }
  const at = options.at ?? now();
  db.prepare(`UPDATE ${table(schema, 'people')} SET display_name=?,organization=?,title=?,updated_at=? WHERE id=?`).run(next.display_name,next.organization,next.title,at,current.id);
  if (ci(oldName) !== ci(next.display_name)) {
    db.prepare(`INSERT OR IGNORE INTO ${table(schema, 'person_aliases')}(person_id,alias,created_at) VALUES(?,?,?)`).run(current.id,oldName,at);
  }
  return rawPerson(db,current.id,schema);
}

function addAlias(db, id, alias, options = {}) {
  const schema = options.schema ?? 'main';
  const person = canonicalPerson(db,id,schema);
  if (!person) throw new Error(`Person P-${personNumber(id)} not found`);
  const value = String(alias ?? '').trim();
  if (!value) throw new Error('alias must be a non-empty string');
  db.prepare(`INSERT OR IGNORE INTO ${table(schema, 'person_aliases')}(person_id,alias,created_at) VALUES(?,?,?)`).run(person.id,value,options.at ?? now());
  return aliasesFor(db,person.id,schema);
}

function removeAlias(db, id, alias, options = {}) {
  const schema = options.schema ?? 'main';
  const person = canonicalPerson(db,id,schema);
  if (!person) throw new Error(`Person P-${personNumber(id)} not found`);
  db.prepare(`DELETE FROM ${table(schema, 'person_aliases')} WHERE person_id=? AND alias=?`).run(person.id,String(alias ?? '').trim());
  return aliasesFor(db,person.id,schema);
}

function merge(db, fromValue, intoValue, options = {}) {
  const schema = options.schema ?? 'main';
  const fromRaw = rawPerson(db,fromValue,schema);
  const intoRaw = rawPerson(db,intoValue,schema);
  if (!fromRaw || !intoRaw) throw new Error('Person merge source or target not found');
  const from = canonicalPerson(db,fromRaw,schema);
  const into = canonicalPerson(db,intoRaw,schema);
  if (from.id === into.id) return { changed:false, from:fromRaw, person:into };
  if (fromRaw.status !== STATUS_ACTIVE) throw new Error('Merge source must be ACTIVE');
  if (from.is_self && !into.is_self) throw new Error('Canonical self Person cannot be merged into another identity');
  const at = options.at ?? now();
  if (schemaVersion(db,schema) >= 2) {
    // Important Dates are Person-owned state. Reassign them before the identity redirect.
    // A conflicting target birthday fails closed through the unique index rather than
    // silently choosing one of two contradictory birthdays.
    db.prepare(`UPDATE ${table(schema,'important_dates')} SET person_id=?,updated_at=? WHERE person_id=?`).run(into.id,at,from.id);
  }
  db.prepare(`UPDATE ${table(schema, 'people')} SET merged_into=?,updated_at=? WHERE status='MERGED' AND merged_into=?`).run(into.id,at,from.id);
  db.prepare(`UPDATE ${table(schema, 'people')} SET status='MERGED',merged_into=?,is_self=0,updated_at=? WHERE id=?`).run(into.id,at,from.id);
  return { changed:true, from:rawPerson(db,from.id,schema), person:into };
}

function search(db, query, options = {}) {
  const schema = options.schema ?? 'main';
  const q = ci(query);
  const limit = Number.isSafeInteger(options.limit) ? Math.min(Math.max(options.limit,1),200) : 50;
  const rows = db.prepare(`SELECT * FROM ${table(schema, 'people')}`).all();
  const aliasRows = db.prepare(`SELECT a.alias,p.* FROM ${table(schema, 'person_aliases')} a JOIN ${table(schema, 'people')} p ON p.id=a.person_id`).all();
  const candidates = [];
  for (const row of rows) if ([row.display_name,row.organization,row.title].some((v) => ci(v).includes(q))) candidates.push(row);
  for (const row of aliasRows) if (ci(row.alias).includes(q)) candidates.push(row);
  return canonicalizeCandidates(db,candidates,schema,options).slice(0,limit);
}

function ensureSingleSelf(db, schema = 'main', selfName = SELF_NAME) {
  const rows = db.prepare(`SELECT * FROM ${table(schema, 'people')} WHERE is_self=1`).all();
  if (rows.length === 1 && rows[0].status === STATUS_ACTIVE) return rows[0];
  if (rows.length > 0) throw new Error('Contacts must contain exactly one ACTIVE self Person');
  const matches = matchingPeople(db,selfName,{schema,allowSurname:false});
  if (matches.length > 1) throw new Error('Canonical self identity is ambiguous');
  if (matches.length === 1) {
    db.prepare(`UPDATE ${table(schema, 'people')} SET is_self=1,updated_at=? WHERE id=?`).run(now(),matches[0].id);
    return rawPerson(db,matches[0].id,schema);
  }
  return createOrReuse(db,{display_name:selfName,is_self:true},{schema}).person;
}

function integrity(db, schema = 'main') {
  const people = db.prepare(`SELECT * FROM ${table(schema, 'people')} ORDER BY id`).all();
  const self = people.filter((x) => x.is_self === 1 && x.status === STATUS_ACTIVE);
  const errors = [];
  if (self.length !== 1) errors.push(`expected exactly one ACTIVE self Person, found ${self.length}`);
  for (const row of people) {
    if (row.status === STATUS_MERGED) {
      try {
        const canonical = canonicalPerson(db,row,schema);
        if (!canonical || canonical.status !== STATUS_ACTIVE) errors.push(`P-${row.id} does not redirect to ACTIVE Person`);
        if (rawPerson(db,row.merged_into,schema)?.status !== STATUS_ACTIVE) errors.push(`P-${row.id} merge target is not direct ACTIVE target`);
      } catch (error) { errors.push(`P-${row.id}: ${error.message}`); }
    }
  }
  if (Number(db.prepare(`PRAGMA ${schemaName(schema)}.user_version`).get().user_version) >= 2) {
    for (const row of db.prepare(`SELECT * FROM ${table(schema,'important_dates')}`).all()) {
      try { normalizeImportantDateInput(row,row); canonicalPerson(db,row.person_id,schema); } catch (error) { errors.push(`DATE-${row.id}: ${error.message}`); }
    }
  }
  const counts=(name)=>Number(db.prepare(`SELECT count(*) n FROM ${table(schema,name)}`).get().n);
  return { ok:errors.length===0, errors, people:people.length, aliases:counts('person_aliases'), important_dates:counts('important_dates'), important_date_reminders:counts('important_date_reminders') };
}


const IMPORTANT_DATE_TYPES = new Set(['BIRTHDAY','ANNIVERSARY','OTHER']);
const IMPORTANT_DATE_OFFSET_UNITS = new Set(['DAYS','WEEKS','MONTHS']);
const importantDateNumber = (value) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const m = typeof value === 'string' ? value.trim().match(/^(?:DATE-)?([1-9]\d*)$/i) : null;
  if (m) return Number(m[1]);
  throw new Error('Expected DATE-<number> or positive integer');
};
const importantDateReminderNumber = (value) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const m = typeof value === 'string' ? value.trim().match(/^(?:IDR-)?([1-9]\d*)$/i) : null;
  if (m) return Number(m[1]);
  throw new Error('Expected IDR-<number> or positive integer');
};
const isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const daysInMonth = (year, month) => [31,isLeapYear(year)?29:28,31,30,31,30,31,31,30,31,30,31][month-1] ?? 0;
const validDateParts = (year, month, day) => Number.isSafeInteger(year) && year >= 1000 && year <= 9999 && Number.isSafeInteger(month) && month >= 1 && month <= 12 && Number.isSafeInteger(day) && day >= 1 && day <= daysInMonth(year,month);
const isoDate = (year, month, day) => `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
function parseIsoDate(value) {
  const m=String(value??'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) throw new Error('Expected YYYY-MM-DD');
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  if(!validDateParts(year,month,day)) throw new Error('Expected real YYYY-MM-DD date');
  return {year,month,day};
}
function addDaysIso(value, delta) {
  const {year,month,day}=parseIsoDate(value);
  const d=new Date(Date.UTC(year,month-1,day));
  d.setUTCDate(d.getUTCDate()+delta);
  return isoDate(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate());
}
function diffDays(fromValue,toValue) {
  const a=parseIsoDate(fromValue),b=parseIsoDate(toValue);
  return Math.round((Date.UTC(b.year,b.month-1,b.day)-Date.UTC(a.year,a.month-1,a.day))/86400000);
}
function subtractOffset(occurrence, value, unit) {
  if(!Number.isSafeInteger(value)||value<0) throw new Error('offset_value must be a non-negative integer');
  if(value===0) return occurrence;
  if(unit==='DAYS') return addDaysIso(occurrence,-value);
  if(unit==='WEEKS') return addDaysIso(occurrence,-value*7);
  if(unit!=='MONTHS') throw new Error('offset_unit must be DAYS, WEEKS, or MONTHS');
  const {year,month,day}=parseIsoDate(occurrence);
  const total=year*12+(month-1)-value,targetYear=Math.floor(total/12),targetMonth=((total%12)+12)%12+1;
  if(targetYear<1000) throw new Error('calendar-month reminder offset is out of supported range');
  return isoDate(targetYear,targetMonth,Math.min(day,daysInMonth(targetYear,targetMonth)));
}
function dateInTimezone(instant, timezone='Europe/Moscow') {
  const d=new Date(instant);
  if(Number.isNaN(d.getTime())) throw new Error('boundary must be a valid ISO timestamp');
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const obj=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}
function normalizeDateType(value) {
  const type=String(value??'').toUpperCase();
  if(!IMPORTANT_DATE_TYPES.has(type)) throw new Error('type must be BIRTHDAY, ANNIVERSARY, or OTHER');
  return type;
}
function normalizeReminderSpecs(specs) {
  if(!Array.isArray(specs)) throw new Error('reminders must be an explicit array');
  const out=[],seen=new Set();
  for(const raw of specs){
    if(!raw||Array.isArray(raw)||typeof raw!=='object') throw new Error('reminder specification must be an object');
    let value=raw.offset_value,unit=String(raw.offset_unit??'').toUpperCase();
    if(!Number.isSafeInteger(value)||value<0) throw new Error('offset_value must be a non-negative integer');
    if(!IMPORTANT_DATE_OFFSET_UNITS.has(unit)) throw new Error('offset_unit must be DAYS, WEEKS, or MONTHS');
    if(unit==='DAYS'&&value>3650||unit==='WEEKS'&&value>520||unit==='MONTHS'&&value>120) throw new Error('reminder offset is too large');
    if(value===0) unit='DAYS';
    const key=`${value}:${unit}`;if(seen.has(key))continue;seen.add(key);out.push({offset_value:value,offset_unit:unit});
  }
  return out.sort((a,b)=>a.offset_unit.localeCompare(b.offset_unit)||a.offset_value-b.offset_value);
}
function normalizeImportantDateInput(input,current=null) {
  const type=input.type==null?(current?.type??null):normalizeDateType(input.type);
  if(!type) throw new Error('type is required');
  const year=Object.hasOwn(input,'year')?(input.year==null?null:Number(input.year)):(current?.year??null);
  const month=Object.hasOwn(input,'month')?Number(input.month):(current?.month??null);
  const day=Object.hasOwn(input,'day')?Number(input.day):(current?.day??null);
  const annual=Object.hasOwn(input,'annual')?Boolean(input.annual):(current?Boolean(current.annual):true);
  if(year!==null&&(!Number.isSafeInteger(year)||year<1000||year>9999)) throw new Error('year must be null or an integer from 1000 to 9999');
  const validationYear=year??2000;
  if(!validDateParts(validationYear,month,day)) throw new Error('month/day is not a real calendar date');
  if(!annual&&year===null) throw new Error('non-annual important date requires a year');
  if((type==='BIRTHDAY'||type==='ANNIVERSARY')&&!annual) throw new Error(`${type} must be annual`);
  return {type,year,month,day,annual:annual?1:0};
}
function rawImportantDate(db,id,schema='main'){return db.prepare(`SELECT * FROM ${table(schema,'important_dates')} WHERE id=?`).get(importantDateNumber(id))??null;}
function remindersForDate(db,id,schema='main'){return db.prepare(`SELECT * FROM ${table(schema,'important_date_reminders')} WHERE important_date_id=? ORDER BY offset_unit,offset_value,id`).all(importantDateNumber(id));}
function formatImportantDateReminder(row){return {id:`IDR-${row.id}`,offset_value:row.offset_value,offset_unit:row.offset_unit,created_at:row.created_at,updated_at:row.updated_at};}
function formatImportantDate(db,row,schema='main',extra={}){
  const canonical=canonicalPerson(db,row.person_id,schema);
  return {id:`DATE-${row.id}`,person:formatPerson(canonical),type:row.type,year:row.year??null,month:row.month,day:row.day,annual:Boolean(row.annual),reminders:remindersForDate(db,row.id,schema).map(formatImportantDateReminder),created_at:row.created_at,updated_at:row.updated_at,...extra};
}
function createImportantDate(db,input,options={}){
  const schema=options.schema??'main',person=canonicalPerson(db,input.person_id,schema);
  if(!person) throw new Error('Person not found');
  const value=normalizeImportantDateInput(input),specs=normalizeReminderSpecs(input.reminders),at=options.at??now();
  const info=db.prepare(`INSERT INTO ${table(schema,'important_dates')}(person_id,type,year,month,day,annual,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(person.id,value.type,value.year,value.month,value.day,value.annual,at,at);
  const id=Number(info.lastInsertRowid),insert=db.prepare(`INSERT INTO ${table(schema,'important_date_reminders')}(important_date_id,offset_value,offset_unit,created_at,updated_at) VALUES(?,?,?,?,?)`);
  for(const spec of specs)insert.run(id,spec.offset_value,spec.offset_unit,at,at);
  return rawImportantDate(db,id,schema);
}
function listImportantDates(db,options={}){
  const schema=options.schema??'main',rows=db.prepare(`SELECT * FROM ${table(schema,'important_dates')} ORDER BY month,day,id`).all(),type=options.type==null?null:normalizeDateType(options.type);
  let target=null;if(options.person_id!=null){target=canonicalPerson(db,options.person_id,schema);if(!target)throw new Error('Person not found');}
  return rows.filter(row=>(!type||row.type===type)&&(!target||canonicalPerson(db,row.person_id,schema)?.id===target.id));
}
function updateImportantDate(db,id,patch,options={}){
  const schema=options.schema??'main',current=rawImportantDate(db,id,schema);if(!current)throw new Error('ImportantDate not found');
  const value=normalizeImportantDateInput(patch,current),at=options.at??now();
  db.prepare(`UPDATE ${table(schema,'important_dates')} SET type=?,year=?,month=?,day=?,annual=?,updated_at=? WHERE id=?`).run(value.type,value.year,value.month,value.day,value.annual,at,current.id);
  return rawImportantDate(db,current.id,schema);
}
function setImportantDateReminders(db,id,specs,options={}){
  const schema=options.schema??'main',date=rawImportantDate(db,id,schema);if(!date)throw new Error('ImportantDate not found');
  const desired=normalizeReminderSpecs(specs),at=options.at??now(),existing=remindersForDate(db,date.id,schema),keys=new Set(desired.map(x=>`${x.offset_value}:${x.offset_unit}`));
  const del=db.prepare(`DELETE FROM ${table(schema,'important_date_reminders')} WHERE id=?`);
  for(const row of existing)if(!keys.has(`${row.offset_value}:${row.offset_unit}`))del.run(row.id);
  const present=new Set(remindersForDate(db,date.id,schema).map(x=>`${x.offset_value}:${x.offset_unit}`)),ins=db.prepare(`INSERT INTO ${table(schema,'important_date_reminders')}(important_date_id,offset_value,offset_unit,created_at,updated_at) VALUES(?,?,?,?,?)`);
  for(const spec of desired)if(!present.has(`${spec.offset_value}:${spec.offset_unit}`))ins.run(date.id,spec.offset_value,spec.offset_unit,at,at);
  db.prepare(`UPDATE ${table(schema,'important_dates')} SET updated_at=? WHERE id=?`).run(at,date.id);
  return rawImportantDate(db,date.id,schema);
}
function deleteImportantDate(db,id,schema='main'){
  const date=rawImportantDate(db,id,schema);if(!date)throw new Error('ImportantDate not found');
  db.prepare(`DELETE FROM ${table(schema,'important_dates')} WHERE id=?`).run(date.id);return date;
}
function occurrenceFor(row,year){
  if(!row.annual&&row.year!==year)return null;
  if(!row.annual&&row.year==null)return null;
  const y=row.annual?year:row.year,d=Math.min(row.day,daysInMonth(y,row.month));
  return isoDate(y,row.month,d);
}
function importantDateOccurrences(db,options={}){
  const from=parseIsoDate(options.from_date).year,endDate=addDaysIso(options.from_date,options.horizon_days),endYear=parseIsoDate(endDate).year,out=[];
  for(const row of listImportantDates(db,options)){
    const years=row.annual?Array.from({length:endYear-from+1},(_,i)=>from+i):[row.year];
    for(const year of years){const occurrence=occurrenceFor(row,year);if(occurrence&&occurrence>=options.from_date&&occurrence<=endDate)out.push({row,occurrence_date:occurrence,days_until:diffDays(options.from_date,occurrence)});}
  }
  return out.sort((a,b)=>a.occurrence_date.localeCompare(b.occurrence_date)||a.row.id-b.row.id);
}
function dueReminderCandidates(db,boundaryIso,options={}){
  const schema=options.schema??'main',today=dateInTimezone(boundaryIso),{year}=parseIsoDate(today),rows=db.prepare(`SELECT r.*,d.person_id,d.type,d.year,d.month,d.day,d.annual FROM ${table(schema,'important_date_reminders')} r JOIN ${table(schema,'important_dates')} d ON d.id=r.important_date_id ORDER BY r.id`).all(),out=[];
  for(const row of rows){
    const years=row.annual?[year,year+1]:[row.year];
    for(const y of years){if(y==null)continue;const occurrence=occurrenceFor(row,y);if(!occurrence)continue;const trigger=subtractOffset(occurrence,row.offset_value,row.offset_unit);if(trigger>today||occurrence<today)continue;
      const delivery=db.prepare(`SELECT * FROM ${table(schema,'important_date_deliveries')} WHERE reminder_id=? AND occurrence_key=?`).get(row.id,occurrence);
      if(delivery?.status==='DELIVERED')continue;
      if(delivery?.status==='CLAIMED'&&delivery.claim_expires_at>boundaryIso)continue;
      out.push({reminder:row,occurrence_date:occurrence,trigger_date:trigger,today});
      break;
    }
  }
  return out.sort((a,b)=>a.trigger_date.localeCompare(b.trigger_date)||a.reminder.id-b.reminder.id);
}
function claimDueImportantDateReminders(db,input,options={}){
  const schema=options.schema??'main',token=String(input.claim_token??'').trim(),boundary=new Date(input.boundary).toISOString(),limit=Number.isSafeInteger(input.limit)?Math.min(Math.max(input.limit,1),100):100;
  if(!token)throw new Error('claim_token is required');
  const expires=new Date(new Date(boundary).getTime()+15*60*1000).toISOString(),candidates=dueReminderCandidates(db,boundary,{schema}).slice(0,limit),claimed=[];
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const item of candidates){
      const prior=db.prepare(`SELECT * FROM ${table(schema,'important_date_deliveries')} WHERE reminder_id=? AND occurrence_key=?`).get(item.reminder.id,item.occurrence_date);
      let changed=0;
      if(!prior){changed=db.prepare(`INSERT OR IGNORE INTO ${table(schema,'important_date_deliveries')}(reminder_id,occurrence_key,status,claim_token,claimed_at,claim_expires_at,delivered_at) VALUES(?,?,'CLAIMED',?,?,?,NULL)`).run(item.reminder.id,item.occurrence_date,token,boundary,expires).changes;}
      else if(prior.status==='CLAIMED'&&prior.claim_expires_at<=boundary){changed=db.prepare(`UPDATE ${table(schema,'important_date_deliveries')} SET claim_token=?,claimed_at=?,claim_expires_at=? WHERE reminder_id=? AND occurrence_key=? AND status='CLAIMED' AND claim_expires_at<=?`).run(token,boundary,expires,item.reminder.id,item.occurrence_date,boundary).changes;}
      if(changed)claimed.push(item);
    }
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  return renderImportantDateClaim(db,token,null,{schema});
}
const RU_MONTHS=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function pluralRu(value,one,few,many){const n=Math.abs(value)%100,n1=n%10;if(n>10&&n<20)return many;if(n1>1&&n1<5)return few;if(n1===1)return one;return many;}
function reminderPolicyLabel(value,unit){if(value===0)return'в день события';if(unit==='MONTHS')return`за ${value} ${pluralRu(value,'месяц','месяца','месяцев')}`;if(unit==='WEEKS')return`за ${value} ${pluralRu(value,'неделю','недели','недель')}`;return`за ${value} ${pluralRu(value,'день','дня','дней')}`;}
function renderImportantDateClaim(db,token,boundaryIso=null,options={}){
  const schema=options.schema??'main',rows=db.prepare(`SELECT x.occurrence_key,x.claimed_at,r.id reminder_id,r.offset_value,r.offset_unit,d.*,x.claim_token FROM ${table(schema,'important_date_deliveries')} x JOIN ${table(schema,'important_date_reminders')} r ON r.id=x.reminder_id JOIN ${table(schema,'important_dates')} d ON d.id=r.important_date_id WHERE x.status='CLAIMED' AND x.claim_token=? ORDER BY x.occurrence_key,r.id`).all(token);
  const reference=boundaryIso??rows[0]?.claimed_at??now(),today=dateInTimezone(reference),items=[];
  for(const row of rows){const occurrence=occurrenceFor(row,parseIsoDate(row.occurrence_key).year);if(occurrence!==row.occurrence_key)continue;const trigger=subtractOffset(occurrence,row.offset_value,row.offset_unit);if(trigger>today||occurrence<today)continue;const person=canonicalPerson(db,row.person_id,schema);if(!person)continue;items.push({reminder_id:`IDR-${row.reminder_id}`,important_date_id:`DATE-${row.id}`,person:formatPerson(person),type:row.type,occurrence_date:occurrence,days_until:diffDays(today,occurrence),offset_value:row.offset_value,offset_unit:row.offset_unit});}
  const typeLabel=t=>t==='BIRTHDAY'?'день рождения':t==='ANNIVERSARY'?'годовщина':'важная дата';
  const lines=items.map(x=>{const {month,day}=parseIsoDate(x.occurrence_date),when=x.days_until===0?'сегодня':`через ${x.days_until} ${pluralRu(x.days_until,'день','дня','дней')}`;return`• ${x.person.display_name} — ${typeLabel(x.type)} ${day} ${RU_MONTHS[month-1]} (${when}; ${reminderPolicyLabel(x.offset_value,x.offset_unit)})`;});
  return {ok:true,count:items.length,message:items.length?`Важные даты:
${lines.join('\n')}`:'',items};
}
function settleImportantDateClaim(db,input,options={}){
  const schema=options.schema??'main',token=String(input.claim_token??'').trim();if(!token)throw new Error('claim_token is required');
  const at=options.at??now();db.exec('BEGIN IMMEDIATE');try{let result;if(input.delivered===true)result=db.prepare(`UPDATE ${table(schema,'important_date_deliveries')} SET status='DELIVERED',delivered_at=?,claim_expires_at=? WHERE status='CLAIMED' AND claim_token=?`).run(at,at,token);else result=db.prepare(`DELETE FROM ${table(schema,'important_date_deliveries')} WHERE status='CLAIMED' AND claim_token=?`).run(token);db.exec('COMMIT');return{ok:true,count:Number(result.changes),delivered:input.delivered===true};}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}

function mutate(db, operationType, payload, fn, options = {}) {
  const schema = options.schema ?? 'main';
  const key = String(payload.operation_key ?? '').trim();
  if (!key) throw new Error('operation_key is required');
  const hash = requestHash(payload);
  const prior = db.prepare(`SELECT * FROM ${table(schema,'operation_results')} WHERE operation_key=?`).get(key);
  if (prior) {
    if (prior.operation_type !== operationType || prior.request_hash !== hash) throw new Error('operation_key was already used for a different request');
    return { ...JSON.parse(prior.result_json), idempotent_replay:true };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.prepare(`INSERT INTO ${table(schema,'operation_results')}(operation_key,operation_type,request_hash,result_json,created_at) VALUES(?,?,?,?,?)`)
      .run(key,operationType,hash,JSON.stringify(result),now());
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = {
  CONTACT_SCHEMA_VERSION, SELF_NAME, STATUS_ACTIVE, STATUS_MERGED,
  ci, personNumber, importantDateNumber, importantDateReminderNumber, schemaSql, schemaVersion, requireSchema, ensureSchema, ensureSingleSelf, integrity,
  rawPerson, canonicalPerson, formatPerson, aliasesFor, matchingPeople, resolve, search,
  createOrReuse, updateFacts, addAlias, removeAlias, merge, mutate,
  rawImportantDate, formatImportantDate, listImportantDates, createImportantDate, updateImportantDate, setImportantDateReminders, deleteImportantDate,
  importantDateOccurrences, claimDueImportantDateReminders, renderImportantDateClaim, settleImportantDateClaim,
  normalizeReminderSpecs, subtractOffset, dateInTimezone,
};
