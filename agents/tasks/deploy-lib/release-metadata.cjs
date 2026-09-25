#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const VERSION_RE = /^0[.]4[.][0-9]+$/u;
const CONTACTS_VERSION_RE = /^0[.]1[.][0-9]+$/u;
const RUNTIME_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*[.]cjs$/u;
const WORKSPACE_FILES = ['AGENTS.md','SOUL.md','USER.md','IDENTITY.md','HEARTBEAT.md'];

function fail(message) { throw new Error(message); }
function tuple(value) {
  const match = /^(\d+)[.](\d+)[.](\d+)$/u.exec(value || '');
  return match ? match.slice(1).map(Number) : null;
}
function shellQuote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }

function validateTaskctlRuntime(runtime, targetVersion) {
  if (!runtime || runtime.format !== 'node-cjs-modules-v1') fail('invalid taskctl runtime format');
  if (!Array.isArray(runtime.files) || runtime.files.length < 2 || runtime.files.length > 16) fail('invalid taskctl runtime file set');
  if (new Set(runtime.files).size !== runtime.files.length || runtime.files.some((file) => !RUNTIME_FILE_RE.test(file))) fail('invalid taskctl runtime file name');
  for (const required of ['runtime.cjs','database.cjs','domain.cjs','reviews.cjs']) if (!runtime.files.includes(required)) fail(`required taskctl runtime module missing: ${required}`);
  if (!VERSION_RE.test(targetVersion || '')) fail('invalid target taskctl version');
}

function validateRelease(release, expectedOpenClawVersion) {
  if (release?.format !== 'task-agent-release-v2') fail('invalid Task release format');
  const targetTaskctl = release?.generation?.taskctl_version;
  const targetSchema = release?.generation?.sqlite_schema;
  if (!VERSION_RE.test(targetTaskctl || '') || !Number.isSafeInteger(targetSchema) || targetSchema < 1) fail('invalid Task generation');
  if (!tuple(release?.generation?.openclaw_build_version) || release.generation.openclaw_build_version !== expectedOpenClawVersion || release?.generation?.openclaw_compat !== expectedOpenClawVersion) fail('invalid OpenClaw release compatibility');
  if (release?.generation?.typebox_version !== '1.3.15') fail('invalid TypeBox release identity');
  validateTaskctlRuntime(release.taskctl_runtime, targetTaskctl);

  if (release?.plugin?.name !== 'openclaw-plugin-taskctl' || !VERSION_RE.test(release?.plugin?.version || '')) fail('invalid Task plugin identity');
  if (release?.plugin?.artifact !== `artifacts/openclaw-plugin-taskctl-${release.plugin.version}.tgz` || !SHA256_RE.test(release?.plugin?.sha256 || '')) fail('invalid Task plugin artifact');

  const contacts = release?.shared_contacts;
  if (!contacts || contacts.release_path !== '../../shared/contacts/release.json' || !SHA256_RE.test(contacts.release_sha256 || '') || !CONTACTS_VERSION_RE.test(contacts.implementation_version || '') || !Number.isSafeInteger(contacts.sqlite_schema) || contacts.sqlite_schema < 1 || !['exact','target-exact'].includes(contacts.predecessor_mode)) fail('invalid Shared Contacts release binding');

  const materializer = release?.calendar_materializer;
  if (!materializer || materializer.kind !== 'openclaw-command-automation-v1' || typeof materializer.declaration_key !== 'string' || !materializer.declaration_key.trim() || typeof materializer.name !== 'string' || !materializer.name.trim() || typeof materializer.cron !== 'string' || !materializer.cron.trim() || materializer.timezone !== 'Europe/Moscow' || materializer.exact !== true || !Number.isSafeInteger(materializer.timeout_seconds) || materializer.timeout_seconds < 1) fail('invalid Recurrence materializer');

  const reminder = release?.reminder_dispatcher;
  if (!reminder || reminder.kind !== 'openclaw-command-automation-v1' || typeof reminder.declaration_key !== 'string' || !reminder.declaration_key.trim() || typeof reminder.name !== 'string' || !reminder.name.trim() || typeof reminder.cron !== 'string' || !reminder.cron.trim() || reminder.timezone !== 'Europe/Moscow' || reminder.exact !== true || JSON.stringify(reminder.command_argv_suffix) !== JSON.stringify(['reminder-internal','dispatch-send']) || !Number.isSafeInteger(reminder.timeout_seconds) || reminder.timeout_seconds < 1 || reminder.delivery_channel !== 'telegram' || reminder.delivery_account !== 'tasks' || reminder.delivery_recipient_source !== 'tasks-owner-allowFrom-singleton' || reminder.predecessor_mode !== 'exact') fail('invalid Reminder dispatcher');

  const important = release?.important_date_dispatcher;
  if (!important || important.kind !== 'openclaw-script-automation-v1' || typeof important.declaration_key !== 'string' || !important.declaration_key.trim() || typeof important.name !== 'string' || !important.name.trim() || typeof important.cron !== 'string' || !important.cron.trim() || important.timezone !== 'Europe/Moscow' || important.exact !== true || typeof important.script !== 'string' || !important.script.trim() || important.tool !== 'contact_date_reminder_dispatch' || !Number.isSafeInteger(important.timeout_seconds) || important.timeout_seconds < 1 || !Number.isSafeInteger(important.tool_budget) || important.tool_budget < 1 || important.delivery_channel !== 'telegram' || important.delivery_account !== 'default' || important.delivery_recipient_source !== 'commands.ownerAllowFrom-singleton' || important.best_effort !== false || important.predecessor_mode !== 'exact') fail('invalid Important Dates dispatcher');

  const from = release?.from;
  if (!from || !SHA_RE.test(from.source_revision || '')) fail('invalid predecessor source revision');
  if (!Array.isArray(from.plugin_versions) || from.plugin_versions.length !== 1 || !from.plugin_versions.every((value) => VERSION_RE.test(value))) fail('invalid predecessor plugin identity');
  if (!Array.isArray(from.sqlite_schemas) || from.sqlite_schemas.length !== 1 || !from.sqlite_schemas.every((value) => Number.isSafeInteger(value) && value >= 1)) fail('invalid predecessor schema identity');
  if (!Array.isArray(from.taskctl_versions) || from.taskctl_versions.length !== 1 || !from.taskctl_versions.every((value) => VERSION_RE.test(value))) fail('invalid predecessor taskctl identity');
  if (!from.workspace_sha256 || Object.keys(from.workspace_sha256).sort().join(',') !== WORKSPACE_FILES.slice().sort().join(',') || !WORKSPACE_FILES.every((file) => SHA256_RE.test(from.workspace_sha256[file] || ''))) fail('invalid predecessor workspace fingerprint set');
  if (!SHA256_RE.test(from.tools_sha256 || '')) fail('invalid predecessor tool-policy fingerprint');

  return { release, targetTaskctl, targetSchema, contacts, materializer, reminder, important, from };
}

function envLines(validated) {
  const { release:r, targetTaskctl, targetSchema, contacts:sc, materializer:mat, reminder:rem, important:idr, from } = validated;
  const rows = {
    TARGET_TASKCTL_VERSION: targetTaskctl,
    TARGET_SQLITE_SCHEMA: targetSchema,
    TASKCTL_RUNTIME_FORMAT: r.taskctl_runtime.format,
    FROM_SOURCE_REVISION: from.source_revision,
    FROM_SQLITE_SCHEMAS: from.sqlite_schemas.join(' '),
    FROM_TASKCTL_VERSIONS: from.taskctl_versions.join(' '),
    TARGET_PLUGIN_VERSION: r.plugin.version,
    CONTACTS_ENABLED: '1',
    CONTACTS_PREDECESSOR_MODE: sc.predecessor_mode,
    TARGET_CONTACTS_VERSION: sc.implementation_version,
    TARGET_CONTACTS_SCHEMA: sc.sqlite_schema,
    CONTACTS_RELEASE_REL: sc.release_path,
    EXPECTED_CONTACTS_RELEASE_SHA: sc.release_sha256,
    ARTIFACT_REL: r.plugin.artifact,
    EXPECTED_ARTIFACT_SHA: r.plugin.sha256,
    MATERIALIZER_ENABLED: '1',
    MATERIALIZER_DECLARATION: mat.declaration_key,
    MATERIALIZER_NAME: mat.name,
    MATERIALIZER_CRON: mat.cron,
    MATERIALIZER_TIMEZONE: mat.timezone,
    MATERIALIZER_TIMEOUT: mat.timeout_seconds,
    REMINDER_ENABLED: '1',
    REMINDER_DECLARATION: rem.declaration_key,
    REMINDER_NAME: rem.name,
    REMINDER_CRON: rem.cron,
    REMINDER_TIMEZONE: rem.timezone,
    REMINDER_COMMAND_SUFFIX_JSON: JSON.stringify(rem.command_argv_suffix),
    REMINDER_TIMEOUT: rem.timeout_seconds,
    REMINDER_CHANNEL: rem.delivery_channel,
    REMINDER_ACCOUNT: rem.delivery_account,
    IMPORTANT_DATE_ENABLED: '1',
    IMPORTANT_DATE_DECLARATION: idr.declaration_key,
    IMPORTANT_DATE_NAME: idr.name,
    IMPORTANT_DATE_CRON: idr.cron,
    IMPORTANT_DATE_TIMEZONE: idr.timezone,
    IMPORTANT_DATE_SCRIPT: idr.script,
    IMPORTANT_DATE_TOOL: idr.tool,
    IMPORTANT_DATE_TIMEOUT: idr.timeout_seconds,
    IMPORTANT_DATE_TOOL_BUDGET: idr.tool_budget,
    IMPORTANT_DATE_CHANNEL: idr.delivery_channel,
    IMPORTANT_DATE_ACCOUNT: idr.delivery_account,
    FROM_PLUGIN_VERSIONS: from.plugin_versions.join(' '),
    FROM_TOOLS_SHA: from.tools_sha256,
  };
  for (const file of WORKSPACE_FILES) rows[`FROM_WS_${file.replace(/[.]/g,'_')}`] = from.workspace_sha256[file];
  return Object.entries(rows).map(([key,value]) => `${key}=${shellQuote(value)}`).join('\n') + '\n';
}

if (require.main === module) {
  try {
    const [command, releasePath, expectedOpenClawVersion] = process.argv.slice(2);
    if (!['validate','env'].includes(command) || !releasePath || !expectedOpenClawVersion) fail('Usage: release-metadata.cjs <validate|env> <release.json> <expected-openclaw-version>');
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    const validated = validateRelease(release, expectedOpenClawVersion);
    if (command === 'env') process.stdout.write(envLines(validated));
    else process.stdout.write('TASK_RELEASE_METADATA_PASS\n');
  } catch (error) {
    process.stderr.write(`task-release-metadata: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { validateRelease, validateTaskctlRuntime, envLines };
