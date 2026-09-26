#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diagnose } from './diagnose.mjs';
import {
  CONTROL_VERSION,
  REQUIRED_WORKFLOW,
  ROLLOUT_REQUIRED_WORKFLOWS,
  isProtectedDeploymentPath,
  isRolloutProtectedPath,
  isStagedValidationOnlyPath,
  parseGitHubMergeCommit,
  selectMergedMainPrNumber,
  validateControlComment,
  validateMergedMainPr,
  validateOperationEvidence,
  validateOperationalBinding,
} from './lib.mjs';

const API_VERSION = '2022-11-28';
const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.OPC_HOME || os.homedir();
const stateDir = process.env.OPC_STATE_DIR || path.join(home, '.local', 'state', 'openclaw-production-control');
const stateFile = path.join(stateDir, 'state.json');
const lockFile = path.join(stateDir, 'controller.lock');
const installedRevisionFile = process.env.OPC_INSTALLED_REVISION_FILE || path.join(here, 'installed-revision');
const tokenFile = process.env.OPC_GITHUB_TOKEN_FILE || path.join(home, '.config', 'openclaw-production-control', 'github-token');
const sourceDir = process.env.OPC_SOURCE_DIR || path.join(home, '.local', 'share', 'openclaw-production-control', 'openclaw-agents');
const rolloutSourceDir = process.env.OPC_ROLLOUT_SOURCE_DIR || path.join(home, '.local', 'share', 'openclaw-production-control', 'openclaw-agents-rollout');
const deployWrapper = process.env.OPC_DEPLOY_WRAPPER || path.join(here, 'execute-deploy.sh');
const rolloutWrapper = process.env.OPC_ROLLOUT_WRAPPER || path.join(here, 'execute-rollout.sh');
const controllerCiWorkflow = 'task-production-control-ci.yml';
const SHA_RE = /^[0-9a-f]{40}$/u;
let operationalBinding = null;

const now = () => new Date().toISOString();

function setOperationalBinding(candidate) {
  operationalBinding = validateOperationalBinding(candidate);
  return operationalBinding;
}

function currentBinding() {
  if (!operationalBinding) throw new Error('production-control binding is not initialized');
  return operationalBinding;
}

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
}

function acquireLock() {
  ensureStateDir();
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeFileSync(fd, `${process.pid} ${now()}\n`);
  } catch {
    throw new Error(`controller lock already exists: ${lockFile}`);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
  };
  process.once('exit', release);
  return release;
}

function readToken() {
  const st = fs.statSync(tokenFile);
  if ((st.mode & 0o077) !== 0) throw new Error('GitHub token file must not be group/world accessible');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('GitHub token file owner mismatch');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token || token.length < 20) throw new Error('GitHub token file is empty or invalid');
  return token;
}

export function resolveProtectedPathBaseline(state) {
  if (Object.hasOwn(state ?? {}, 'protected_path_baseline_sha')) {
    const explicit = state.protected_path_baseline_sha;
    if (!SHA_RE.test(String(explicit))) throw new Error('protected-path baseline evidence invalid');
    return String(explicit);
  }
  const legacy = String(state?.controller_revision ?? '');
  if (!SHA_RE.test(legacy)) throw new Error('legacy protected-path baseline evidence invalid');
  return legacy;
}

function readState() {
  if (!fs.existsSync(stateFile)) throw new Error('controller state is not initialized');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.version !== CONTROL_VERSION) throw new Error(`unsupported controller state version ${state.version}`);
  setOperationalBinding(state);
  state.protected_path_baseline_sha = resolveProtectedPathBaseline(state);
  return state;
}

export function assertInstalledControllerRevision(state) {
  const expected = String(state?.controller_revision ?? '');
  if (!SHA_RE.test(expected)) throw new Error('controller state revision evidence invalid');
  if (!fs.existsSync(installedRevisionFile)) throw new Error('installed controller revision evidence missing');
  const installed = fs.readFileSync(installedRevisionFile, 'utf8').trim();
  if (!SHA_RE.test(installed)) throw new Error('installed controller revision evidence invalid');
  if (installed !== expected) throw new Error('installed controller revision does not match bootstrapped revision');
}

function writeState(state) {
  ensureStateDir();
  const temp = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, stateFile);
  fs.chmodSync(stateFile, 0o600);
}

function requestSource(record) {
  return record?.source === 'semantic' ? 'semantic' : 'github';
}

function advanceWatermarkForRecord(state, requestId, record) {
  if (requestSource(record) === 'github') state.watermark = Math.max(state.watermark, requestId);
}

export function allocateSemanticRequestId(state, clock = Date.now) {
  let id = Number(clock());
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('semantic request clock did not produce a positive safe integer');
  while (Object.hasOwn(state.requests || {}, String(id))) {
    id += 1;
    if (!Number.isSafeInteger(id)) throw new Error('semantic request id space exhausted');
  }
  return id;
}

export function recordAdvancesGitHubWatermark(record) {
  return requestSource(record) === 'github';
}

async function githubGet(endpoint) {
  const token = readToken();
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'openclaw-production-control',
    },
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) throw new Error(`GitHub API GET ${endpoint} failed: ${response.status}`);
  return data;
}

async function listControlComments() {
  const binding = currentBinding();
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const rows = await githubGet(`/repos/${binding.control_repository}/issues/${binding.control_issue}/comments?per_page=100&page=${page}`);
    out.push(...rows);
    if (rows.length < 100) return out.sort((a, b) => Number(a.id) - Number(b.id));
  }
  throw new Error('control issue exceeds supported pagination bound');
}

async function getMainSha() {
  const binding = currentBinding();
  const commit = await githubGet(`/repos/${binding.implementation_repository}/commits/main`);
  if (!SHA_RE.test(commit?.sha ?? '')) throw new Error('cannot resolve implementation main SHA');
  return commit.sha;
}

async function runtimeContractVersionAtSha(sha) {
  if (!SHA_RE.test(sha ?? '')) throw new Error('runtime-contract lookup requires exact SHA');
  const binding = currentBinding();
  const data = await githubGet(`/repos/${binding.implementation_repository}/contents/runtime-contract.json?ref=${sha}`);
  if (data?.encoding !== 'base64' || typeof data?.content !== 'string') throw new Error('runtime-contract content response is invalid');
  const contract = JSON.parse(Buffer.from(data.content.replace(/\s+/gu, ''), 'base64').toString('utf8'));
  const version = contract?.openclaw?.version;
  if (contract?.format !== 'openclaw-agents-runtime-contract-v1' || typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) throw new Error('runtime-contract OpenClaw version is invalid');
  return version;
}

function compareRuntimeVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

async function workflowSucceeded(workflow, sha) {
  const binding = currentBinding();
  const data = await githubGet(`/repos/${binding.implementation_repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&event=push&status=completed&per_page=20`);
  return Array.isArray(data?.workflow_runs) && data.workflow_runs.some((run) => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' && run.conclusion === 'success');
}

async function hasMergedMainPr(sha) {
  const binding = currentBinding();
  const repository = binding.implementation_repository;
  const commit = await githubGet(`/repos/${repository}/commits/${sha}`);
  if (commit?.sha !== sha) throw new Error('GitHub commit provenance response does not match requested SHA');
  const merge = parseGitHubMergeCommit(commit);
  if (!merge) return false;
  const associated = await githubGet(`/repos/${repository}/commits/${sha}/pulls`);
  if (!Array.isArray(associated)) throw new Error('GitHub associated PR response did not return a list');
  const prNumber = selectMergedMainPrNumber(associated, sha, merge.headParentSha);
  if (!prNumber) return false;
  const pr = await githubGet(`/repos/${repository}/pulls/${prNumber}`);
  return validateMergedMainPr(pr, prNumber, sha, merge.headParentSha);
}

async function changedFiles(base, head) {
  if (base === head) return [];
  const binding = currentBinding();
  const comparison = await githubGet(`/repos/${binding.implementation_repository}/compare/${base}...${head}`);
  if (!Array.isArray(comparison?.files)) throw new Error('GitHub comparison did not return changed files');
  if (comparison.files.length >= 300) throw new Error('comparison file set reaches GitHub safety bound');
  return comparison.files.map((file) => file.filename);
}

async function runDiagnostics(requestId, sha, expectedProductionBaselineSha = null) {
  let result;
  try { result = await diagnose({ expectedProductionBaselineSha }); }
  catch (error) { result = { ok: false, error: 'diagnostic-failed', message: error.message, checks: {} }; }
  return { ...result, checked_at: now(), sha, request_id: requestId };
}

function gitExec(args, token, options = {}) {
  const askpass = path.join(stateDir, `git-askpass-${process.pid}.sh`);
  if (!fs.existsSync(askpass)) {
    fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token" ;; *) printf "%s\\n" "$OPC_GITHUB_TOKEN" ;; esac\n', { mode: 0o700 });
  }
  try {
    return execFileSync('git', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeout ?? 60000,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', OPC_GITHUB_TOKEN: token },
    }).trim();
  } finally {
    try { fs.unlinkSync(askpass); } catch {}
  }
}

function prepareSourceCheckout(targetSha, checkoutDir = sourceDir) {
  const token = readToken();
  const binding = currentBinding();
  const repoUrl = `https://github.com/${binding.implementation_repository}.git`;
  fs.mkdirSync(checkoutDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(checkoutDir, 0o700);
  if (!fs.existsSync(path.join(checkoutDir, '.git'))) {
    gitExec(['init', '.'], token, { cwd: checkoutDir });
    gitExec(['remote', 'add', 'origin', repoUrl], token, { cwd: checkoutDir });
  } else {
    gitExec(['remote', 'set-url', 'origin', repoUrl], token, { cwd: checkoutDir });
  }
  gitExec(['fetch', '--force', '--no-tags', '--depth=1', 'origin', 'refs/heads/main'], token, { cwd: checkoutDir, timeout: 120000 });
  const fetched = gitExec(['rev-parse', 'FETCH_HEAD'], token, { cwd: checkoutDir });
  if (fetched !== targetSha) throw new Error(`fetched main ${fetched} does not equal requested ${targetSha}`);
  gitExec(['checkout', '--detach', '--force', 'FETCH_HEAD'], token, { cwd: checkoutDir });
  gitExec(['clean', '-fdx'], token, { cwd: checkoutDir });
  const head = gitExec(['rev-parse', 'HEAD'], token, { cwd: checkoutDir });
  if (head !== targetSha) throw new Error('prepared checkout HEAD mismatch');
}

function unitIsActive(unit) {
  try {
    const value = execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8', timeout: 5000 }).trim();
    return value === 'active' || value === 'activating';
  } catch { return false; }
}

function resultPath(requestId) {
  return path.join(stateDir, 'executions', `request-${requestId}.json`);
}

async function validateDeployTarget(state, sha) {
  if (state.deployment_blocked) throw new Error(`deployments blocked: ${state.block_reason || 'reconciliation required'}`);
  const mainSha = await getMainSha();
  if (sha !== mainSha) throw new Error('requested SHA is not current implementation main');
  if (!(await hasMergedMainPr(sha))) throw new Error('requested SHA is not associated with a merged implementation main pull request');
  if (!(await workflowSucceeded(REQUIRED_WORKFLOW, sha))) throw new Error('required Task Agent CI push run is not successful');
  const protectedChanges = (await changedFiles(state.protected_path_baseline_sha, sha)).filter(isProtectedDeploymentPath);
  if (protectedChanges.length) throw new Error(`target changes protected deployment-control paths: ${protectedChanges.join(', ')}`);
  if (state.mode === 'STAGED') {
    if (!state.last_diagnostic?.ok) throw new Error('staged deployment requires a successful private diagnostic first');
    if (!(await workflowSucceeded(controllerCiWorkflow, sha))) throw new Error('production-controller CI push run is not successful');
    const baselineChanges = await changedFiles(state.production_baseline_sha, sha);
    const unsafe = baselineChanges.filter((file) => !isStagedValidationOnlyPath(file));
    if (unsafe.length) throw new Error(`staged validation is not guaranteed no-op; runtime-relevant changes exist: ${unsafe.join(', ')}`);
    return { validationOnly: true };
  }
  if (state.mode !== 'ACTIVE') throw new Error(`controller mode ${state.mode} does not permit deployment`);
  return { validationOnly: false };
}

async function validateRolloutTarget(state, sha) {
  if (state.deployment_blocked) throw new Error(`deployments blocked: ${state.block_reason || 'reconciliation required'}`);
  if (state.mode !== 'ACTIVE') throw new Error(`controller mode ${state.mode} does not permit OpenClaw rollout`);
  const mainSha = await getMainSha();
  if (sha !== mainSha) throw new Error('requested rollout SHA is not current implementation main');
  if (!(await hasMergedMainPr(sha))) throw new Error('requested rollout SHA is not associated with a merged implementation main pull request');
  for (const workflow of ROLLOUT_REQUIRED_WORKFLOWS) {
    if (!(await workflowSucceeded(workflow, sha))) throw new Error(`required rollout CI push run is not successful: ${workflow}`);
  }
  const protectedChanges = (await changedFiles(state.protected_path_baseline_sha, sha)).filter(isRolloutProtectedPath);
  if (protectedChanges.length) throw new Error(`rollout target changes protected production-control paths: ${protectedChanges.join(', ')}`);
  const predecessorVersion = await runtimeContractVersionAtSha(state.production_baseline_sha);
  const targetVersion = await runtimeContractVersionAtSha(sha);
  if (compareRuntimeVersions(targetVersion, predecessorVersion) <= 0) throw new Error(`rollout target OpenClaw ${targetVersion} is not newer than production ${predecessorVersion}`);
  return { predecessorVersion, targetVersion };
}

function startDetachedOperation(state, requestId, operation, source = 'github') {
  const isRollout = operation.type === 'rollout-openclaw';
  const checkoutDir = isRollout ? rolloutSourceDir : sourceDir;
  prepareSourceCheckout(operation.sha, checkoutDir);
  const unit = isRollout ? `openclaw-rollout-${requestId}` : `openclaw-task-deploy-${requestId}`;
  const record = {
    type: operation.type,
    source,
    sha: operation.sha,
    state: 'STARTING',
    unit,
    accepted_at: now(),
  };
  if (operation.validationOnly) record.validation_only = true;
  if (isRollout) {
    record.predecessor_openclaw_version = operation.predecessorVersion;
    record.target_openclaw_version = operation.targetVersion;
  }
  state.requests[String(requestId)] = record;
  writeState(state);
  const wrapper = isRollout ? rolloutWrapper : deployWrapper;
  const timeout = isRollout ? '90min' : '45min';
  const args = [
    '--user', `--unit=${unit}`, '--collect', '--property=Type=exec',
    `--property=TimeoutStartSec=${timeout}`, `--property=RuntimeMaxSec=${timeout}`,
    wrapper, String(requestId), checkoutDir, stateDir,
  ];
  if (isRollout) args.push(operation.predecessorVersion);
  try {
    execFileSync('systemd-run', args, { stdio: 'ignore', timeout: 15000 });
    record.state = 'IN_PROGRESS';
    record.started_at = now();
  } catch {
    record.state = 'BLOCKED_PRE_MUTATION';
    record.completed_at = now();
    record.reason = 'failed-to-start-detached-unit';
    advanceWatermarkForRecord(state, requestId, record);
  }
  writeState(state);
}

function activeOperation(state) {
  const active = Object.entries(state.requests || {}).filter(([, value]) =>
    ['deploy', 'rollout-openclaw'].includes(value?.type) && (value?.state === 'STARTING' || value?.state === 'IN_PROGRESS'));
  if (active.length > 1) throw new Error('multiple active production operations found in controller state');
  return active[0] ?? null;
}

async function reconcileOperation(state) {
  const active = activeOperation(state);
  if (!active) return false;
  const [key, record] = active;
  const requestId = Number(key);
  const file = resultPath(requestId);
  if (!fs.existsSync(file)) {
    if (unitIsActive(record.unit)) return true;
    record.state = 'UNKNOWN';
    record.completed_at = now();
    record.evidence_error = 'detached unit ended without durable result evidence';
    state.deployment_blocked = true;
    state.block_reason = `request ${requestId} outcome unknown`;
    advanceWatermarkForRecord(state, requestId, record);
    state.last_diagnostic = await runDiagnostics(requestId, record.sha);
    writeState(state);
    return false;
  }

  let evidence = null;
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const terminal = validateOperationEvidence(record, evidence, requestId);
  let outcome = terminal.outcome;
  let block = terminal.block;
  if (!terminal.ok) record.evidence_error = terminal.reason;
  let postDiagnostic = null;

  if (outcome === 'SUCCESS') {
    if (record.validation_only && evidence.mutation_started !== false) {
      outcome = 'UNKNOWN';
      block = true;
      record.evidence_error = 'staged validation operation mutated production';
    } else {
      try {
        prepareSourceCheckout(record.sha, sourceDir);
        postDiagnostic = await runDiagnostics(requestId, record.sha, record.sha);
        if (!postDiagnostic.ok) {
          outcome = 'BLOCKED_REQUIRES_JUDGMENT';
          block = true;
          record.evidence_error = 'post-operation target diagnostics failed';
        } else {
          state.production_baseline_sha = record.sha;
          if (record.validation_only) {
            state.mode = 'ACTIVE';
            state.activated_at = now();
          }
        }
      } catch (error) {
        outcome = 'BLOCKED_REQUIRES_JUDGMENT';
        block = true;
        record.reconciliation_error = error.message;
      }
    }
  } else {
    postDiagnostic = await runDiagnostics(requestId, record.sha);
  }

  record.state = outcome;
  record.completed_at = now();
  record.evidence = evidence && typeof evidence === 'object' ? {
    operation: evidence.operation ?? null,
    source_revision: evidence.source_revision ?? null,
    mutation_started: evidence.mutation_started === true,
    outcome: evidence.outcome ?? null,
    result_file: file,
  } : { result_file: file };
  if (postDiagnostic) state.last_diagnostic = postDiagnostic;
  advanceWatermarkForRecord(state, requestId, record);
  if (block) {
    state.deployment_blocked = true;
    state.block_reason = `request ${requestId} ended ${outcome}`;
  }
  writeState(state);
  return false;
}

async function processDiagnostic(state, id) {
  const sha = await getMainSha();
  state.requests[String(id)] = { type: 'diagnose', source: 'github', sha, state: 'IN_PROGRESS', accepted_at: now() };
  writeState(state);
  const result = await runDiagnostics(id, sha);
  state.requests[String(id)].state = result.ok ? 'SUCCESS' : 'FAILED';
  state.requests[String(id)].completed_at = now();
  state.last_diagnostic = result;
  state.watermark = Math.max(state.watermark, id);
  writeState(state);
}

async function poll() {
  const state = readState();
  assertInstalledControllerRevision(state);
  const binding = currentBinding();
  if (await reconcileOperation(state)) return;
  const comments = await listControlComments();
  for (const comment of comments) {
    const id = Number(comment.id);
    if (id <= state.watermark) continue;
    const validated = validateControlComment(comment, state.minimum_comment_id, binding);
    if (!validated.ok) {
      state.watermark = Math.max(state.watermark, id);
      writeState(state);
      continue;
    }
    if (validated.command.type === 'diagnose') {
      await processDiagnostic(state, id);
      continue;
    }
    if (validated.command.type === 'rollout-openclaw') {
      try {
        const { predecessorVersion, targetVersion } = await validateRolloutTarget(state, validated.command.sha);
        startDetachedOperation(state, id, { type: 'rollout-openclaw', sha: validated.command.sha, predecessorVersion, targetVersion });
      } catch (error) {
        state.requests[String(id)] = { type: 'rollout-openclaw', source: 'github', sha: validated.command.sha, state: 'BLOCKED_PRE_MUTATION', completed_at: now(), reason: error.message };
        state.watermark = Math.max(state.watermark, id);
        writeState(state);
      }
      return;
    }
    try {
      const { validationOnly } = await validateDeployTarget(state, validated.command.sha);
      startDetachedOperation(state, id, { type: 'deploy', sha: validated.command.sha, validationOnly });
    } catch (error) {
      state.requests[String(id)] = { type: 'deploy', source: 'github', sha: validated.command.sha, state: 'BLOCKED_PRE_MUTATION', completed_at: now(), reason: error.message };
      state.watermark = Math.max(state.watermark, id);
      writeState(state);
    }
    return;
  }
}

function summarizeLastDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ok: value.ok === true,
    checked_at: typeof value.checked_at === 'string' ? value.checked_at : null,
    request_id: Number.isSafeInteger(value.request_id) ? value.request_id : null,
  };
}

export function getLocalStatus() {
  const state = readState();
  const active = activeOperation(state);
  return {
    ok: true,
    mode: state.mode,
    deployment_blocked: state.deployment_blocked === true,
    block_reason: state.block_reason ?? null,
    controller_revision: state.controller_revision ?? null,
    protected_path_baseline_sha: state.protected_path_baseline_sha ?? null,
    production_baseline_sha: state.production_baseline_sha ?? null,
    active_request: active ? {
      id: Number(active[0]), type: active[1]?.type ?? null, source: requestSource(active[1]), sha: active[1]?.sha ?? null, state: active[1]?.state ?? null,
    } : null,
    last_diagnostic: summarizeLastDiagnostic(state.last_diagnostic),
  };
}

export async function runLocalDiagnostics() {
  const result = await diagnose();
  return { ...result, checked_at: now() };
}

export const getSemanticStatus = getLocalStatus;
export const runSemanticDiagnostics = runLocalDiagnostics;

export async function requestSemanticDeployment(sha) {
  if (!SHA_RE.test(sha ?? '')) throw new Error('semantic deploy requires an exact 40-character lowercase SHA');
  const release = acquireLock();
  try {
    const state = readState();
    assertInstalledControllerRevision(state);
    if (await reconcileOperation(state)) throw new Error('another production operation is already in progress');
    const { validationOnly } = await validateDeployTarget(state, sha);
    const requestId = allocateSemanticRequestId(state);
    try {
      startDetachedOperation(state, requestId, { type: 'deploy', sha, validationOnly }, 'semantic');
    } catch (error) {
      const record = { type: 'deploy', source: 'semantic', sha, state: 'BLOCKED_PRE_MUTATION', completed_at: now(), reason: error.message };
      state.requests[String(requestId)] = record;
      writeState(state);
      return { ok: false, accepted: false, request_id: requestId, sha, state: record.state, reason: record.reason };
    }
    const record = state.requests[String(requestId)];
    return {
      ok: record?.state === 'IN_PROGRESS', accepted: record?.state === 'IN_PROGRESS', request_id: requestId, sha,
      source: 'semantic', state: record?.state ?? 'UNKNOWN', validation_only: validationOnly,
    };
  } finally {
    release();
  }
}

function requiredArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`${name} is required`);
  return args[index + 1];
}

async function bootstrap(args) {
  ensureStateDir();
  if (fs.existsSync(stateFile)) throw new Error('controller state already exists');
  const productionSha = requiredArg(args, '--production-sha');
  const controllerSha = requiredArg(args, '--controller-sha');
  if (!SHA_RE.test(productionSha)) throw new Error('--production-sha is invalid');
  if (!SHA_RE.test(controllerSha)) throw new Error('--controller-sha is invalid');
  const binding = setOperationalBinding({
    control_repository: requiredArg(args, '--control-repository'),
    implementation_repository: requiredArg(args, '--implementation-repository'),
    control_issue: Number(requiredArg(args, '--control-issue')),
    owner_login: requiredArg(args, '--owner-login'),
    owner_id: Number(requiredArg(args, '--owner-id')),
  });
  await githubGet(`/repos/${binding.control_repository}`);
  await githubGet(`/repos/${binding.control_repository}/issues/${binding.control_issue}`);
  await githubGet(`/repos/${binding.implementation_repository}`);
  await githubGet(`/repos/${binding.implementation_repository}/commits/${productionSha}`);
  await githubGet(`/repos/${binding.implementation_repository}/commits/${controllerSha}`);
  const mainSha = await getMainSha();
  if (controllerSha !== mainSha) throw new Error('controller bootstrap revision must equal current implementation main');
  const comments = await listControlComments();
  const watermark = comments.reduce((max, comment) => Math.max(max, Number(comment.id) || 0), 0);
  const state = {
    version: CONTROL_VERSION,
    mode: 'STAGED',
    ...binding,
    minimum_comment_id: watermark,
    watermark,
    controller_revision: controllerSha,
    protected_path_baseline_sha: controllerSha,
    production_baseline_sha: productionSha,
    deployment_blocked: false,
    block_reason: null,
    last_diagnostic: null,
    requests: {},
    bootstrapped_at: now(),
  };
  writeState(state);
  process.stdout.write(`${JSON.stringify({ ok: true, mode: state.mode, watermark, controller_revision: controllerSha, protected_path_baseline_sha: controllerSha, production_baseline_sha: productionSha })}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'diagnose-local') {
    process.stdout.write(`${JSON.stringify(await runLocalDiagnostics())}\n`);
    return;
  }
  if (command === 'status-local') {
    process.stdout.write(`${JSON.stringify(getLocalStatus())}\n`);
    return;
  }
  const release = acquireLock();
  try {
    if (command === 'bootstrap') await bootstrap(args);
    else if (command === 'poll') await poll();
    else throw new Error('Usage: controller.mjs <bootstrap --production-sha SHA --controller-sha SHA --control-repository OWNER/REPO --implementation-repository OWNER/REPO --control-issue N --owner-login LOGIN --owner-id ID|poll|diagnose-local|status-local>');
  } finally {
    release();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`production-control: ${error.message}\n`);
    process.exitCode = 2;
  });
}
