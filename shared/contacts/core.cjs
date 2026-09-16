'use strict';

const crypto = require('node:crypto');

const CONTACT_SCHEMA_VERSION = 1;
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
    `CREATE TABLE IF NOT EXISTS ${s}.operation_results(operation_key TEXT PRIMARY KEY, operation_type TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${s}.idx_people_single_self ON people(is_self) WHERE is_self=1;`,
    `CREATE INDEX IF NOT EXISTS ${s}.idx_people_status ON people(status,id);`,
    `CREATE INDEX IF NOT EXISTS ${s}.idx_person_aliases_alias ON person_aliases(alias);`,
  ].join('\n');
}

function ensureSchema(db, schema = 'main') {
  db.exec(schemaSql(schema));
  const version = Number(db.prepare(`PRAGMA ${schemaName(schema)}.user_version`).get().user_version);
  if (version === 0) db.exec(`PRAGMA ${schemaName(schema)}.user_version=${CONTACT_SCHEMA_VERSION}`);
  else if (version !== CONTACT_SCHEMA_VERSION) throw new Error(`Unsupported Contacts schema version ${version}`);
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
  return { ok:errors.length===0, errors, people:people.length, aliases:Number(db.prepare(`SELECT count(*) n FROM ${table(schema,'person_aliases')}`).get().n) };
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
  ci, personNumber, schemaSql, ensureSchema, ensureSingleSelf, integrity,
  rawPerson, canonicalPerson, formatPerson, aliasesFor, matchingPeople, resolve, search,
  createOrReuse, updateFacts, addAlias, removeAlias, merge, mutate,
};
