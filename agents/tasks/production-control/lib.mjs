export const CONTROL_VERSION = 1;
export const REQUIRED_WORKFLOW = 'task-agent-ci.yml';
export const ROLLOUT_REQUIRED_WORKFLOWS = ['task-agent-ci.yml', 'task-production-control-ci.yml', 'engineer-agent-ci.yml'];

const CONTROL_RUNTIME_PATHS = [
  'agents/tasks/production-control/controller.mjs',
  'agents/tasks/production-control/lib.mjs',
  'agents/tasks/production-control/diagnose.mjs',
  'agents/tasks/production-control/execute-deploy.sh',
  'agents/tasks/production-control/execute-rollout.sh',
  'agents/tasks/production-control/poll.sh',
  'agents/tasks/production-control/install.sh',
  'agents/tasks/production-control/bootstrap.sh',
  'agents/tasks/production-control/plugin-registry-state.cjs',
  'agents/tasks/production-control/openclaw-task-production-control.service',
  'agents/tasks/production-control/openclaw-task-production-control.timer',
];

export const PROTECTED_DEPLOYMENT_PATHS = [
  'runtime-contract.json',
  'shared/runtime-contract/',
  ...CONTROL_RUNTIME_PATHS,
  'agents/tasks/deploy.sh',
  'agents/tasks/deploy-support.cjs',
  'agents/tasks/recover.sh',
  'agents/tasks/install.sh',
  'agents/tasks/workspace-layout.mjs',
  '.github/workflows/task-agent-ci.yml',
];

export const ROLLOUT_PROTECTED_PATHS = [
  'shared/runtime-contract/',
  ...CONTROL_RUNTIME_PATHS,
  'agents/tasks/deploy.sh',
  'agents/tasks/deploy-support.cjs',
  'agents/tasks/recover.sh',
  'agents/tasks/install.sh',
  'agents/tasks/workspace-layout.mjs',
  'agents/tasks/plugins/taskctl/src/production-control.ts',
  '.github/workflows/task-agent-ci.yml',
  '.github/workflows/task-production-control-ci.yml',
  '.github/workflows/engineer-agent-ci.yml',
];

export const STAGED_VALIDATION_ONLY_PATHS = [
  'agents/tasks/README.md',
  'agents/tasks/deploy.sh',
  'agents/tasks/deploy-support.cjs',
  'agents/tasks/tests/deploy.sh',
  ...CONTROL_RUNTIME_PATHS,
  'agents/tasks/production-control/tests/',
  'agents/tasks/production-control/README.md',
  'agents/tasks/production-control/BREAK-GLASS-RECONCILE.md',
  'agents/tasks/production-control/BASELINE-BREAK-GLASS-RECONCILE.md',
  'agents/tasks/production-control/SEMANTIC-OPERATIONS.md',
  '.github/workflows/task-production-control-ci.yml',
  '.github/workflows/task-agent-ci.yml',
];

const SHA_RE = /^[0-9a-f]{40}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/u;
const OPERATION_OUTCOMES = new Set([
  'SUCCESS',
  'ROLLED_BACK',
  'BLOCKED_PRE_MUTATION',
  'BLOCKED_REQUIRES_JUDGMENT',
  'RECOVERY_REQUIRED',
  'UNKNOWN',
]);

export function validateOperationalBinding(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('production-control binding missing');
  const controlRepository = String(candidate.control_repository ?? '');
  const implementationRepository = String(candidate.implementation_repository ?? '');
  const controlIssue = Number(candidate.control_issue);
  const ownerLogin = String(candidate.owner_login ?? '');
  const ownerId = Number(candidate.owner_id);
  if (!REPOSITORY_RE.test(controlRepository)) throw new Error('invalid control repository');
  if (!REPOSITORY_RE.test(implementationRepository)) throw new Error('invalid implementation repository');
  if (controlRepository === implementationRepository) throw new Error('control and implementation repositories must be distinct');
  if (!Number.isSafeInteger(controlIssue) || controlIssue < 1) throw new Error('invalid control issue');
  if (!LOGIN_RE.test(ownerLogin)) throw new Error('invalid owner login');
  if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error('invalid owner id');
  return {
    control_repository: controlRepository,
    implementation_repository: implementationRepository,
    control_issue: controlIssue,
    owner_login: ownerLogin,
    owner_id: ownerId,
  };
}

export function parseCommand(body) {
  const text = String(body ?? '').trim();
  if (text === '/diagnose tasks') return { type: 'diagnose' };
  const match = text.match(/^\/deploy tasks ([0-9a-f]{40})$/);
  if (match) return { type: 'deploy', sha: match[1] };
  const rollout = text.match(/^\/rollout openclaw ([0-9a-f]{40})$/);
  if (rollout) return { type: 'rollout-openclaw', sha: rollout[1] };
  return null;
}

export function parseGitHubMergeCommit(commit) {
  const parents = Array.isArray(commit?.parents) ? commit.parents.map((parent) => parent?.sha) : [];
  if (parents.length !== 2 || parents.some((sha) => !SHA_RE.test(sha ?? ''))) return null;
  return { baseParentSha: parents[0], headParentSha: parents[1] };
}

function mergedMainPrMatches(pr, sha, headParentSha) {
  const number = Number(pr?.number);
  return SHA_RE.test(sha ?? '')
    && SHA_RE.test(headParentSha ?? '')
    && Number.isSafeInteger(number)
    && number > 0
    && Boolean(pr?.merged_at)
    && pr.base?.ref === 'main'
    && pr.head?.sha === headParentSha
    && pr.merge_commit_sha === sha;
}

export function selectMergedMainPrNumber(pullRequests, sha, headParentSha) {
  if (!Array.isArray(pullRequests)) return null;
  const matches = pullRequests.filter((pr) => mergedMainPrMatches(pr, sha, headParentSha));
  if (matches.length !== 1) return null;
  return Number(matches[0].number);
}

export function validateMergedMainPr(pr, prNumber, sha, headParentSha) {
  return Number(pr?.number) === prNumber && mergedMainPrMatches(pr, sha, headParentSha);
}

export function validateControlComment(comment, minimumCommentId = 0, binding) {
  let operational;
  try { operational = validateOperationalBinding(binding); }
  catch { return { ok: false, reason: 'invalid-binding' }; }
  if (!comment || !Number.isSafeInteger(Number(comment.id))) return { ok: false, reason: 'invalid-comment-id' };
  const id = Number(comment.id);
  if (id <= minimumCommentId) return { ok: false, reason: 'pre-activation-comment' };
  if (Number(comment.user?.id) !== operational.owner_id || comment.user?.login !== operational.owner_login) return { ok: false, reason: 'wrong-author' };
  if (!comment.created_at || !comment.updated_at || comment.created_at !== comment.updated_at) return { ok: false, reason: 'edited-comment' };
  const command = parseCommand(comment.body);
  if (!command) return { ok: false, reason: 'unrecognized-command' };
  return { ok: true, id, command };
}

function pathMatches(path, entries) {
  return entries.some((entry) => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
}

export function isProtectedDeploymentPath(path) {
  return pathMatches(path, PROTECTED_DEPLOYMENT_PATHS);
}

export function isRolloutProtectedPath(path) {
  return pathMatches(path, ROLLOUT_PROTECTED_PATHS);
}

export function isStagedValidationOnlyPath(path) {
  return pathMatches(path, STAGED_VALIDATION_ONLY_PATHS);
}

export function validateOperationEvidence(record, evidence, requestId) {
  const invalid = (reason) => ({ ok: false, outcome: 'UNKNOWN', block: true, reason });
  if (!record || typeof record !== 'object' || !evidence || typeof evidence !== 'object') return invalid('operation evidence missing');
  if (!Number.isSafeInteger(requestId) || requestId < 1 || Number(evidence.request_id) !== requestId) return invalid('operation request identity mismatch');
  if (!['deploy', 'rollout-openclaw'].includes(record.type)) return invalid('unsupported operation record type');
  const evidenceOperation = evidence.operation ?? record.type;
  if (evidenceOperation !== record.type) return invalid('operation type mismatch');
  if (!SHA_RE.test(record.sha ?? '') || evidence.source_revision !== record.sha) return invalid('operation source revision mismatch');
  if (typeof evidence.mutation_started !== 'boolean' || typeof evidence.block_further_deployments !== 'boolean') return invalid('operation terminal flags are incomplete');

  const outcome = OPERATION_OUTCOMES.has(evidence.outcome) ? evidence.outcome : 'UNKNOWN';
  const mutationStarted = evidence.mutation_started;
  const block = evidence.block_further_deployments;

  if (outcome === 'SUCCESS' && block) return invalid('successful operation cannot block further changes');
  if (outcome === 'BLOCKED_PRE_MUTATION' && (mutationStarted || block)) return invalid('pre-mutation refusal evidence is inconsistent');
  if (outcome === 'ROLLED_BACK' && (!mutationStarted || block)) return invalid('rolled-back evidence is inconsistent');
  if (outcome === 'RECOVERY_REQUIRED' && (!mutationStarted || !block)) return invalid('recovery-required evidence is inconsistent');
  if (outcome === 'UNKNOWN' && !block) return invalid('unknown operation evidence must block further changes');
  if (outcome === 'BLOCKED_REQUIRES_JUDGMENT' && mutationStarted && !block) return invalid('post-mutation judgment-required evidence must block further changes');
  return { ok: true, outcome, block, reason: null };
}

export function mapDeployEvidence(evidence, exitCode = null) {
  if (!evidence || typeof evidence !== 'object') return { outcome: 'UNKNOWN', block: true };
  if (evidence.result === 'PASS' && exitCode === 0) return { outcome: 'SUCCESS', block: false };
  if (evidence.result === 'ROLLED_BACK') return { outcome: 'ROLLED_BACK', block: false };
  if (evidence.result === 'BLOCKED' && evidence.mutation_started === false) return { outcome: 'BLOCKED_PRE_MUTATION', block: false };
  if (evidence.result === 'BLOCKED' && evidence.mutation_started === true) return { outcome: 'RECOVERY_REQUIRED', block: true };
  return { outcome: 'UNKNOWN', block: true };
}

export function statusStateForOutcome(outcome) {
  if (outcome === 'SUCCESS') return 'success';
  if (outcome === 'UNKNOWN' || outcome === 'RECOVERY_REQUIRED') return 'error';
  return 'failure';
}
