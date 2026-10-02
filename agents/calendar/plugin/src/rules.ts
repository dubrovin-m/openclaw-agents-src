import { createHash } from "node:crypto";

export type DurableClassificationRule = {
  id: string;
  condition: string;
  categoryId: string;
};

export type DurableHygieneException = {
  id: string;
  condition: string;
  requireLeader: boolean;
  requireAgenda: boolean;
};

export type DurableRules = {
  classification: DurableClassificationRule[];
  hygiene: DurableHygieneException[];
};

export type RuleProposalInput = {
  action: "create" | "replace" | "delete";
  kind: "classification" | "hygiene_exception";
  rule_id?: string;
  condition?: string;
  category_id?: string;
  require_leader?: boolean;
  require_agenda?: boolean;
};

type RuleConfigView = {
  leaves: Array<{ id: string }>;
  durableRules: DurableRules;
};

type StoredRuleProposal = {
  proposalId: string;
  action: RuleProposalInput["action"];
  kind: RuleProposalInput["kind"];
  targetDigest?: string;
  rule?: DurableClassificationRule | DurableHygieneException;
  ruleId?: string;
  summary: string;
  createdAt: number;
};

type JsonObject = Record<string, unknown>;
const RULE_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/u;
const PROPOSAL_ID_PATTERN = /^proposal_[0-9a-f]{16}$/u;
const MAX_CONDITION_LENGTH = 320;
const MAX_APPROVAL_DESCRIPTION_LENGTH = 512;
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSALS = 100;
const proposals = new Map<string, StoredRuleProposal>();

const asRecord = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const normalizeText = (value: string) => value.trim().replace(/\s+/gu, " ");
const hash = (value: unknown, length = 16) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
const ruleDigest = (rule: DurableClassificationRule | DurableHygieneException) => hash(rule, 32);

function condition(value: unknown, path: string) {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  const normalized = normalizeText(value);
  if (!normalized || normalized.length > MAX_CONDITION_LENGTH) {
    throw new Error(`${path} must contain 1-${MAX_CONDITION_LENGTH} characters`);
  }
  return normalized;
}

function ruleId(value: unknown, path: string) {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  const normalized = value.trim();
  if (!RULE_ID_PATTERN.test(normalized)) throw new Error(`${path} is invalid`);
  return normalized;
}

function assertOnlyKeys(object: JsonObject, allowed: string[], path: string) {
  if (Object.keys(object).some((key) => !allowed.includes(key))) {
    throw new Error(`${path} contains unsupported fields`);
  }
}

export function parseDurableRules(value: unknown): DurableRules {
  if (value === undefined) return { classification: [], hygiene: [] };
  const root = asRecord(value);
  if (!root) throw new Error("durableRules must be an object");
  assertOnlyKeys(root, ["classification", "hygiene"], "durableRules");
  if (!Array.isArray(root.classification) || !Array.isArray(root.hygiene)) {
    throw new Error("durableRules requires classification and hygiene arrays");
  }
  const classification = root.classification.map((item, index): DurableClassificationRule => {
    const object = asRecord(item);
    if (!object) throw new Error(`durableRules.classification[${index}] must be an object`);
    assertOnlyKeys(object, ["id", "condition", "categoryId"], `durableRules.classification[${index}]`);
    const id = ruleId(object.id, `durableRules.classification[${index}].id`);
    const categoryId = typeof object.categoryId === "string" ? object.categoryId.trim() : "";
    if (!categoryId) throw new Error(`durableRules.classification[${index}].categoryId is required`);
    return { id, condition: condition(object.condition, `durableRules.classification[${index}].condition`), categoryId };
  });
  const hygiene = root.hygiene.map((item, index): DurableHygieneException => {
    const object = asRecord(item);
    if (!object) throw new Error(`durableRules.hygiene[${index}] must be an object`);
    assertOnlyKeys(object, ["id", "condition", "requireLeader", "requireAgenda"], `durableRules.hygiene[${index}]`);
    if (typeof object.requireLeader !== "boolean" || typeof object.requireAgenda !== "boolean") {
      throw new Error(`durableRules.hygiene[${index}] requires boolean requireLeader and requireAgenda`);
    }
    if (object.requireLeader && object.requireAgenda) {
      throw new Error(`durableRules.hygiene[${index}] must waive at least one hygiene requirement`);
    }
    return {
      id: ruleId(object.id, `durableRules.hygiene[${index}].id`),
      condition: condition(object.condition, `durableRules.hygiene[${index}].condition`),
      requireLeader: object.requireLeader,
      requireAgenda: object.requireAgenda,
    };
  });
  const ids = [...classification.map((rule) => rule.id), ...hygiene.map((rule) => rule.id)];
  if (new Set(ids).size !== ids.length) throw new Error("durable rule ids must be unique");
  return { classification, hygiene };
}

export function rulesDigest(rules: DurableRules) {
  return hash(rules, 32);
}

function sweepProposals(now = Date.now()) {
  for (const [id, proposal] of proposals) {
    if (now - proposal.createdAt > PROPOSAL_TTL_MS) proposals.delete(id);
  }
  while (proposals.size >= MAX_PROPOSALS) {
    const oldest = proposals.keys().next().value as string | undefined;
    if (!oldest) break;
    proposals.delete(oldest);
  }
}

function findRule(rules: DurableRules, kind: RuleProposalInput["kind"], id: string) {
  return kind === "classification"
    ? rules.classification.find((rule) => rule.id === id)
    : rules.hygiene.find((rule) => rule.id === id);
}

function expectedKeys(input: RuleProposalInput) {
  if (input.action === "delete") return ["action", "kind", "rule_id"];
  if (input.kind === "classification") {
    return input.action === "replace"
      ? ["action", "kind", "rule_id", "condition", "category_id"]
      : ["action", "kind", "condition", "category_id"];
  }
  return input.action === "replace"
    ? ["action", "kind", "rule_id", "condition", "require_leader", "require_agenda"]
    : ["action", "kind", "condition", "require_leader", "require_agenda"];
}

function normalizeProposal(config: RuleConfigView, input: RuleProposalInput): Omit<StoredRuleProposal, "proposalId" | "createdAt"> {
  const actualKeys = Object.entries(input).filter(([, value]) => value !== undefined).map(([key]) => key).sort();
  const allowedKeys = expectedKeys(input).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(allowedKeys)) {
    throw new Error(`Rule proposal requires exactly: ${allowedKeys.join(", ")}`);
  }
  if (input.action === "delete") {
    const id = ruleId(input.rule_id, "rule_id");
    const existing = findRule(config.durableRules, input.kind, id);
    if (!existing) throw new Error("Rule to delete does not exist in the effective configuration");
    return {
      action: input.action,
      kind: input.kind,
      targetDigest: ruleDigest(existing),
      ruleId: id,
      summary: `Удалить правило Calendar: ${id} — «${existing.condition}»`,
    };
  }

  const normalizedCondition = condition(input.condition, "condition");
  const replacementId = input.action === "replace" ? ruleId(input.rule_id, "rule_id") : undefined;
  const replacement = replacementId ? findRule(config.durableRules, input.kind, replacementId) : undefined;
  if (replacementId && !replacement) {
    throw new Error("Rule to replace does not exist in the effective configuration");
  }

  if (input.kind === "classification") {
    const categoryId = typeof input.category_id === "string" ? input.category_id.trim() : "";
    if (!categoryId || !config.leaves.some((leaf) => leaf.id === categoryId)) {
      throw new Error("category_id must reference one configured Calendar leaf category");
    }
    const id = replacementId ?? `class_${hash({ condition: normalizedCondition, categoryId }, 12)}`;
    const rule: DurableClassificationRule = { id, condition: normalizedCondition, categoryId };
    return {
      action: input.action,
      kind: input.kind,
      ...(replacement ? { targetDigest: ruleDigest(replacement) } : {}),
      rule,
      summary: `${input.action === "replace" ? "Изменить" : "Создать"} правило классификации: «${normalizedCondition}» → ${categoryId}`,
    };
  }

  if (typeof input.require_leader !== "boolean" || typeof input.require_agenda !== "boolean") {
    throw new Error("Hygiene exception requires boolean require_leader and require_agenda");
  }
  if (input.require_leader && input.require_agenda) {
    throw new Error("Hygiene exception must waive leader, agenda, or both");
  }
  const id = replacementId ?? `hyg_${hash({ condition: normalizedCondition, requireLeader: input.require_leader, requireAgenda: input.require_agenda }, 12)}`;
  const rule: DurableHygieneException = {
    id,
    condition: normalizedCondition,
    requireLeader: input.require_leader,
    requireAgenda: input.require_agenda,
  };
  return {
    action: input.action,
    kind: input.kind,
    ...(replacement ? { targetDigest: ruleDigest(replacement) } : {}),
    rule,
    summary: `${input.action === "replace" ? "Изменить" : "Создать"} исключение гигиены: «${normalizedCondition}» — лидер ${rule.requireLeader ? "обязателен" : "не обязателен"}, повестка ${rule.requireAgenda ? "обязательна" : "не обязательна"}`,
  };
}

export function proposeRule(config: RuleConfigView, input: RuleProposalInput) {
  sweepProposals();
  const normalized = normalizeProposal(config, input);
  if (normalized.summary.length > MAX_APPROVAL_DESCRIPTION_LENGTH) {
    throw new Error(`Rule approval summary must be <= ${MAX_APPROVAL_DESCRIPTION_LENGTH} characters`);
  }
  const proposalId = `proposal_${hash(normalized, 16)}`;
  const stored: StoredRuleProposal = { proposalId, ...normalized, createdAt: Date.now() };
  proposals.set(proposalId, stored);
  return {
    proposal_id: proposalId,
    action: stored.action,
    kind: stored.kind,
    summary: stored.summary,
    ...(stored.rule ? { rule: stored.rule } : {}),
    ...(stored.ruleId ? { rule_id: stored.ruleId } : {}),
  };
}

export function getRuleProposal(proposalId: string) {
  sweepProposals();
  if (!PROPOSAL_ID_PATTERN.test(proposalId)) return undefined;
  return proposals.get(proposalId);
}

export function deleteRuleProposal(proposalId: string) {
  proposals.delete(proposalId);
}

export function applyRuleProposal(rules: DurableRules, proposal: StoredRuleProposal): DurableRules {
  if (proposal.action !== "create") {
    const targetId = proposal.action === "delete" ? proposal.ruleId : proposal.rule?.id;
    if (!targetId || !proposal.targetDigest) throw new Error("Calendar rule proposal is incomplete");
    const current = findRule(rules, proposal.kind, targetId);
    if (!current) throw new Error(`Rule to ${proposal.action} no longer exists`);
    if (ruleDigest(current) !== proposal.targetDigest) {
      throw new Error("Calendar durable rule changed after this proposal; create a fresh proposal");
    }
  }

  const next: DurableRules = {
    classification: rules.classification.map((rule) => ({ ...rule })),
    hygiene: rules.hygiene.map((rule) => ({ ...rule })),
  };

  if (proposal.kind === "classification") {
    const target = next.classification;
    if (proposal.action === "delete") {
      const index = target.findIndex((rule) => rule.id === proposal.ruleId);
      if (index < 0) throw new Error("Rule to delete no longer exists");
      target.splice(index, 1);
      return next;
    }
    const rule = proposal.rule;
    if (!rule || !("categoryId" in rule)) throw new Error("Classification proposal is incomplete");
    if (proposal.action === "replace") {
      const index = target.findIndex((existing) => existing.id === rule.id);
      if (index < 0) throw new Error("Rule to replace no longer exists");
      target[index] = rule;
      return next;
    }
    if (target.some((existing) => existing.id === rule.id)) throw new Error("Equivalent durable rule already exists");
    target.push(rule);
    return next;
  }

  const target = next.hygiene;
  if (proposal.action === "delete") {
    const index = target.findIndex((rule) => rule.id === proposal.ruleId);
    if (index < 0) throw new Error("Rule to delete no longer exists");
    target.splice(index, 1);
    return next;
  }
  const rule = proposal.rule;
  if (!rule || !("requireLeader" in rule)) throw new Error("Hygiene proposal is incomplete");
  if (proposal.action === "replace") {
    const index = target.findIndex((existing) => existing.id === rule.id);
    if (index < 0) throw new Error("Rule to replace no longer exists");
    target[index] = rule;
    return next;
  }
  if (target.some((existing) => existing.id === rule.id)) throw new Error("Equivalent durable rule already exists");
  target.push(rule);
  return next;
}
