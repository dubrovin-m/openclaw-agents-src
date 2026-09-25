#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.OPC_HOME || os.homedir();
const openclaw = process.env.OPC_OPENCLAW_STATE || path.join(home, '.openclaw');
const taskctlPath = process.env.OPC_TASKCTL || path.join(home, '.local', 'bin', 'taskctl');
const dbPath = process.env.OPC_TASK_DB || path.join(openclaw, 'data', 'tasks', 'tasks.sqlite3');
const pluginDir = process.env.OPC_TASK_PLUGIN || path.join(openclaw, 'extensions', 'taskctl');
const configPath = process.env.OPC_OPENCLAW_CONFIG || path.join(openclaw, 'openclaw.json');
const deliverables = process.env.OPC_DELIVERABLES || path.join(openclaw, 'workspace', 'deliverables');
const controllerStateFile = process.env.OPC_CONTROLLER_STATE || path.join(home, '.local', 'state', 'openclaw-production-control', 'state.json');
const sourceDir = process.env.OPC_SOURCE_DIR || path.join(home, '.local', 'share', 'openclaw-production-control', 'openclaw-agents');
const installedRevisionFile = process.env.OPC_INSTALLED_REVISION || path.join(here, 'installed-revision');
const runtimeContractPath = process.env.OPC_RUNTIME_CONTRACT || path.join(here, 'runtime-contract.json');
const runtimeHelperPath = process.env.OPC_RUNTIME_CONTRACT_HELPER || path.join(here, 'runtime-contract.mjs');
const openclawBin = process.env.OPC_OPENCLAW_BIN || 'openclaw';
const SHA_RE = /^[0-9a-f]{40}$/u;

function modeOf(p) {
  return (fs.statSync(p).mode & 0o777).toString(8).padStart(3, '0');
}

function systemctlActive(unit) {
  try {
    execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function tcpReady(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function databaseCheck() {
  try {
    if (!fs.existsSync(dbPath)) return { ok: false, reason: 'database-missing' };
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    try {
      const schemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
      const integrity = String(db.prepare('PRAGMA integrity_check').get().integrity_check);
      const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
      return { ok: Number.isSafeInteger(schemaVersion) && schemaVersion >= 1 && integrity === 'ok' && foreignKeyViolations === 0, schema_version: schemaVersion, integrity, foreign_key_violations: foreignKeyViolations };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, reason: 'database-check-failed', error: error.message };
  }
}

function taskctlCheck() {
  try {
    if (!fs.existsSync(taskctlPath)) return { ok: false, reason: 'taskctl-missing' };
    const text = fs.readFileSync(taskctlPath, 'utf8');
    const implementation = text.match(/IMPLEMENTATION_VERSION\s*=\s*['"]([^'"]+)['"]/u)?.[1] ?? null;
    const schema = Number(text.match(/SCHEMA_VERSION\s*=\s*(\d+)/u)?.[1] ?? NaN);
    const mode = modeOf(taskctlPath);
    const compatibleVersion = /^0\.4\.\d+$/u.test(implementation ?? '');
    return { ok: compatibleVersion && Number.isSafeInteger(schema) && schema >= 1 && mode === '700', implementation_version: implementation, schema_version: Number.isFinite(schema) ? schema : null, mode };
  } catch (error) {
    return { ok: false, reason: 'taskctl-check-failed', error: error.message };
  }
}

function pluginCheck() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    const typebox = JSON.parse(fs.readFileSync(path.join(pluginDir, 'node_modules', 'typebox', 'package.json'), 'utf8'));
    const compatibleVersion = /^0\.4\.\d+$/u.test(pkg.version ?? '');
    return {
      ok: pkg.name === 'openclaw-plugin-taskctl' && compatibleVersion && typeof typebox.version === 'string',
      plugin_version: pkg.version ?? null,
      typebox_version: typebox.version ?? null,
      openclaw_peer_range: pkg.peerDependencies?.openclaw ?? null,
      openclaw_plugin_api_range: pkg.openclaw?.compat?.pluginApi ?? null,
      openclaw_build_version: pkg.openclaw?.build?.openclawVersion ?? null,
    };
  } catch (error) {
    return { ok: false, reason: 'plugin-check-failed', error: error.message };
  }
}

function configCheck() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const allow = Array.isArray(config?.plugins?.allow) ? config.plugins.allow : [];
    const entries = config?.agents?.entries;
    const taskAgent = entries && typeof entries === 'object' && !Array.isArray(entries)
      ? entries.tasks
      : Array.isArray(config?.agents?.list)
        ? config.agents.list.find((agent) => agent?.id === 'tasks')
        : null;
    return { ok: allow.includes('taskctl') && Boolean(taskAgent), taskctl_plugin_allowed: allow.includes('taskctl'), task_agent_present: Boolean(taskAgent) };
  } catch (error) {
    return { ok: false, reason: 'config-check-failed', error: error.message };
  }
}

function openclawVersion() {
  const output = execFileSync(openclawBin, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  return output.match(/(?:^|\s)([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/u)?.[1] ?? null;
}

async function runtimeCheck(contractPath = runtimeContractPath) {
  try {
    const helper = await import(`${pathToFileURL(runtimeHelperPath).href}?runtime=${Date.now()}`);
    const contract = helper.loadRuntimeContract(contractPath);
    const nodeSupported = helper.isSupportedNodeVersion(process.version, contract);
    const actualOpenClaw = openclawVersion();
    return {
      ok: nodeSupported && actualOpenClaw === contract.openclaw.version,
      node_version: process.version,
      node_supported: nodeSupported,
      openclaw_version: actualOpenClaw,
      expected_openclaw_version: contract.openclaw.version,
    };
  } catch (error) {
    return { ok: false, reason: 'runtime-contract-check-failed', error: error.message };
  }
}

function readControllerState() {
  const state = JSON.parse(fs.readFileSync(controllerStateFile, 'utf8'));
  const controllerRevision = SHA_RE.test(state?.controller_revision ?? '') ? state.controller_revision : null;
  const protectedPathBaseline = Object.hasOwn(state ?? {}, 'protected_path_baseline_sha')
    ? (SHA_RE.test(state.protected_path_baseline_sha) ? state.protected_path_baseline_sha : null)
    : controllerRevision;
  return {
    controller_revision: controllerRevision,
    protected_path_baseline_sha: protectedPathBaseline,
    production_baseline_sha: SHA_RE.test(state?.production_baseline_sha ?? '') ? state.production_baseline_sha : null,
  };
}

function sourceRevision() {
  const revision = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
  return SHA_RE.test(revision) ? revision : null;
}

function runtimeContractForBaseline(expectedBaselineSha = null) {
  try {
    const state = readControllerState();
    const baseline = expectedBaselineSha ?? state.production_baseline_sha;
    const source = sourceRevision();
    const candidate = path.join(sourceDir, 'runtime-contract.json');
    if (baseline && source === baseline && fs.existsSync(candidate)) return candidate;
  } catch {}
  return runtimeContractPath;
}

function deploymentEvidence() {
  if (!fs.existsSync(deliverables)) return [];
  return fs.readdirSync(deliverables)
    .filter((name) => /^task-agent-deploy-.*-result\.json$/u.test(name))
    .map((name) => {
      const file = path.join(deliverables, name);
      const mtime = fs.statSync(file).mtimeMs;
      try {
        const result = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
          name,
          mtime,
          source_revision: SHA_RE.test(result?.source_revision ?? '') ? result.source_revision : null,
          result: result?.result ?? null,
          stage: result?.stage ?? null,
        };
      } catch {
        return { name, mtime, source_revision: null, result: null, stage: null };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function provenanceCheck(expectedProductionBaselineSha = null) {
  try {
    if (expectedProductionBaselineSha !== null && !SHA_RE.test(expectedProductionBaselineSha)) {
      return { ok: false, reason: 'invalid-expected-production-baseline' };
    }
    const state = readControllerState();
    const effectiveBaseline = expectedProductionBaselineSha ?? state.production_baseline_sha;
    const installed = fs.readFileSync(installedRevisionFile, 'utf8').trim();
    const source = sourceRevision();
    const evidence = deploymentEvidence();
    const baselineEvidence = evidence.find((item) => item.source_revision === effectiveBaseline
      && item.result === 'PASS'
      && (item.stage === 'COMPLETE' || item.stage === 'NOOP')) ?? null;
    const latest = evidence[0] ?? null;
    const ok = Boolean(
      state.controller_revision
      && state.protected_path_baseline_sha
      && state.production_baseline_sha
      && effectiveBaseline
      && installed === state.controller_revision
      && source === effectiveBaseline
      && baselineEvidence,
    );
    return {
      ok,
      controller_revision: state.controller_revision,
      protected_path_baseline_sha: state.protected_path_baseline_sha,
      installed_controller_revision: SHA_RE.test(installed) ? installed : null,
      state_production_baseline_sha: state.production_baseline_sha,
      production_baseline_sha: effectiveBaseline,
      candidate_baseline: effectiveBaseline !== state.production_baseline_sha,
      source_revision: source,
      baseline_evidence: baselineEvidence ? { source_revision: baselineEvidence.source_revision, result: baselineEvidence.result, stage: baselineEvidence.stage } : null,
      latest_evidence: latest ? { source_revision: latest.source_revision, result: latest.result, stage: latest.stage } : null,
    };
  } catch (error) {
    return { ok: false, reason: 'provenance-check-failed', error: error.message };
  }
}

function matchesOpenClawVersion(version, range) {
  return /^(\d+)\.(\d+)\.(\d+)$/.test(version ?? '') && version === range;
}

function releaseCheck({ database, taskctl, plugin, runtime, provenance }) {
  try {
    if (!provenance?.production_baseline_sha || provenance.source_revision !== provenance.production_baseline_sha) {
      return { ok: false, reason: 'baseline-source-not-established' };
    }
    const release = JSON.parse(fs.readFileSync(path.join(sourceDir, 'agents', 'tasks', 'release.json'), 'utf8'));
    if (release?.format !== 'task-agent-release-v2') return { ok: false, reason: 'unsupported-release-format' };
    const expected = {
      taskctl_version: release?.generation?.taskctl_version ?? null,
      sqlite_schema: release?.generation?.sqlite_schema ?? null,
      openclaw_build_version: release?.generation?.openclaw_build_version ?? null,
      openclaw_compat: release?.generation?.openclaw_compat ?? null,
      typebox_version: release?.generation?.typebox_version ?? null,
      plugin_version: release?.plugin?.version ?? null,
    };
    const actual = {
      taskctl_version: taskctl?.implementation_version ?? null,
      sqlite_schema: database?.schema_version ?? null,
      openclaw_version: runtime?.openclaw_version ?? null,
      typebox_version: plugin?.typebox_version ?? null,
      plugin_version: plugin?.plugin_version ?? null,
      openclaw_peer_range: plugin?.openclaw_peer_range ?? null,
      openclaw_plugin_api_range: plugin?.openclaw_plugin_api_range ?? null,
      openclaw_build_version: plugin?.openclaw_build_version ?? null,
    };
    const ok = release?.plugin?.name === 'openclaw-plugin-taskctl'
      && expected.taskctl_version === actual.taskctl_version
      && expected.sqlite_schema === actual.sqlite_schema
      && runtime?.ok === true
      && matchesOpenClawVersion(actual.openclaw_version, expected.openclaw_compat)
      && matchesOpenClawVersion(runtime?.expected_openclaw_version, expected.openclaw_compat)
      && expected.openclaw_compat === actual.openclaw_peer_range
      && expected.openclaw_compat === actual.openclaw_plugin_api_range
      && expected.openclaw_build_version === actual.openclaw_build_version
      && expected.typebox_version === actual.typebox_version
      && expected.plugin_version === actual.plugin_version;
    return { ok, baseline_sha: provenance.production_baseline_sha, expected, actual };
  } catch (error) {
    return { ok: false, reason: 'release-check-failed', error: error.message };
  }
}

export async function diagnose(options = {}) {
  const gatewayActive = systemctlActive('openclaw-gateway.service');
  const gatewayTcp = await tcpReady('127.0.0.1', 18789);
  const database = databaseCheck();
  const taskctl = taskctlCheck();
  const plugin = pluginCheck();
  const provenance = provenanceCheck(options.expectedProductionBaselineSha ?? null);
  const runtime = await runtimeCheck(runtimeContractForBaseline(provenance.production_baseline_sha ?? null));
  const checks = {
    gateway: { ok: gatewayActive && gatewayTcp, service_active: gatewayActive, tcp_ready: gatewayTcp },
    database,
    taskctl,
    plugin,
    nexus_sync: { ok: systemctlActive('nexus-sync.timer'), timer_active: systemctlActive('nexus-sync.timer') },
    config: configCheck(),
    runtime,
    provenance,
  };
  checks.release = releaseCheck({ database, taskctl, plugin, runtime, provenance });
  const required = ['gateway', 'database', 'taskctl', 'plugin', 'nexus_sync', 'config', 'runtime', 'provenance', 'release'];
  return { ok: required.every((name) => checks[name].ok), checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  diagnose().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'diagnostic-failed', message: error.message })}\n`);
    process.exitCode = 2;
  });
}
