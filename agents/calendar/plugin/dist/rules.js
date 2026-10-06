import { createHash } from "node:crypto";
const RULE_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/u;
const PROPOSAL_ID_PATTERN = /^proposal_[0-9a-f]{16}$/u;
const MAX_CONDITION_LENGTH = 320;
const MAX_APPROVAL_DESCRIPTION_LENGTH = 512;
export const RULE_PROPOSAL_TTL_MS = 30 * 60 * 1000;
export const MAX_RULE_PROPOSALS = 100;
const asRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const normalizeText = (value) => value.trim().replace(/\s+/gu, " ");
const hash = (value, length = 16) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
const ruleDigest = (rule) => hash(rule, 32);
function condition(value, path) {
    if (typeof value !== "string")
        throw new Error(`${path} must be a string`);
    const normalized = normalizeText(value);
    if (!normalized || normalized.length > MAX_CONDITION_LENGTH) {
        throw new Error(`${path} must contain 1-${MAX_CONDITION_LENGTH} characters`);
    }
    return normalized;
}
function ruleId(value, path) {
    if (typeof value !== "string")
        throw new Error(`${path} must be a string`);
    const normalized = value.trim();
    if (!RULE_ID_PATTERN.test(normalized))
        throw new Error(`${path} is invalid`);
    return normalized;
}
function assertOnlyKeys(object, allowed, path) {
    if (Object.keys(object).some((key) => !allowed.includes(key))) {
        throw new Error(`${path} contains unsupported fields`);
    }
}
export function parseDurableRules(value) {
    if (value === undefined)
        return { classification: [], hygiene: [] };
    const root = asRecord(value);
    if (!root)
        throw new Error("durableRules must be an object");
    assertOnlyKeys(root, ["classification", "hygiene"], "durableRules");
    if (!Array.isArray(root.classification) || !Array.isArray(root.hygiene)) {
        throw new Error("durableRules requires classification and hygiene arrays");
    }
    const classification = root.classification.map((item, index) => {
        const object = asRecord(item);
        if (!object)
            throw new Error(`durableRules.classification[${index}] must be an object`);
        assertOnlyKeys(object, ["id", "condition", "categoryId"], `durableRules.classification[${index}]`);
        const id = ruleId(object.id, `durableRules.classification[${index}].id`);
        const categoryId = typeof object.categoryId === "string" ? object.categoryId.trim() : "";
        if (!categoryId)
            throw new Error(`durableRules.classification[${index}].categoryId is required`);
        return { id, condition: condition(object.condition, `durableRules.classification[${index}].condition`), categoryId };
    });
    const hygiene = root.hygiene.map((item, index) => {
        const object = asRecord(item);
        if (!object)
            throw new Error(`durableRules.hygiene[${index}] must be an object`);
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
    if (new Set(ids).size !== ids.length)
        throw new Error("durable rule ids must be unique");
    return { classification, hygiene };
}
function storedProposal(value, path) {
    const object = asRecord(value);
    if (!object)
        throw new Error(`${path} must be an object`);
    assertOnlyKeys(object, ["proposalId", "action", "kind", "targetDigest", "rule", "ruleId", "summary", "createdAt"], path);
    const proposalId = typeof object.proposalId === "string" ? object.proposalId : "";
    if (!PROPOSAL_ID_PATTERN.test(proposalId))
        throw new Error(`${path}.proposalId is invalid`);
    const action = object.action;
    if (action !== "create" && action !== "replace" && action !== "delete") {
        throw new Error(`${path}.action is invalid`);
    }
    const kind = object.kind;
    if (kind !== "classification" && kind !== "hygiene_exception") {
        throw new Error(`${path}.kind is invalid`);
    }
    const summary = typeof object.summary === "string" ? object.summary : "";
    if (!summary || summary.length > MAX_APPROVAL_DESCRIPTION_LENGTH) {
        throw new Error(`${path}.summary is invalid`);
    }
    const createdAt = object.createdAt;
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
        throw new Error(`${path}.createdAt is invalid`);
    }
    const targetDigest = object.targetDigest === undefined
        ? undefined
        : typeof object.targetDigest === "string" && /^[0-9a-f]{32}$/u.test(object.targetDigest)
            ? object.targetDigest
            : (() => { throw new Error(`${path}.targetDigest is invalid`); })();
    const persistedRuleId = object.ruleId === undefined ? undefined : ruleId(object.ruleId, `${path}.ruleId`);
    let rule;
    if (object.rule !== undefined) {
        rule = kind === "classification"
            ? parseDurableRules({ classification: [object.rule], hygiene: [] }).classification[0]
            : parseDurableRules({ classification: [], hygiene: [object.rule] }).hygiene[0];
    }
    if (action === "create" && (!rule || targetDigest !== undefined || persistedRuleId !== undefined)) {
        throw new Error(`${path} create proposal is inconsistent`);
    }
    if (action === "replace" && (!rule || !targetDigest || persistedRuleId !== undefined)) {
        throw new Error(`${path} replace proposal is inconsistent`);
    }
    if (action === "delete" && (rule !== undefined || !targetDigest || !persistedRuleId)) {
        throw new Error(`${path} delete proposal is inconsistent`);
    }
    const normalized = {
        action,
        kind,
        ...(targetDigest ? { targetDigest } : {}),
        ...(rule ? { rule } : {}),
        ...(persistedRuleId ? { ruleId: persistedRuleId } : {}),
        summary,
    };
    const expectedProposalId = `proposal_${hash(normalized, 16)}`;
    if (expectedProposalId !== proposalId) {
        throw new Error(`${path}.proposalId does not match the normalized proposal`);
    }
    return { proposalId, ...normalized, createdAt: createdAt };
}
export function parseStoredRuleProposals(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error("pendingRuleProposals must be an array");
    if (value.length > MAX_RULE_PROPOSALS) {
        throw new Error(`pendingRuleProposals must contain at most ${MAX_RULE_PROPOSALS} entries`);
    }
    const proposals = value.map((item, index) => storedProposal(item, `pendingRuleProposals[${index}]`));
    if (new Set(proposals.map((proposal) => proposal.proposalId)).size !== proposals.length) {
        throw new Error("pendingRuleProposals proposal ids must be unique");
    }
    return proposals;
}
export function rulesDigest(rules) {
    return hash(rules, 32);
}
function findRule(rules, kind, id) {
    return kind === "classification"
        ? rules.classification.find((rule) => rule.id === id)
        : rules.hygiene.find((rule) => rule.id === id);
}
function expectedKeys(input) {
    if (input.action === "delete")
        return ["action", "kind", "rule_id"];
    if (input.kind === "classification") {
        return input.action === "replace"
            ? ["action", "kind", "rule_id", "condition", "category_id"]
            : ["action", "kind", "condition", "category_id"];
    }
    return input.action === "replace"
        ? ["action", "kind", "rule_id", "condition", "require_leader", "require_agenda"]
        : ["action", "kind", "condition", "require_leader", "require_agenda"];
}
function normalizeProposal(config, input) {
    const actualKeys = Object.entries(input).filter(([, value]) => value !== undefined).map(([key]) => key).sort();
    const allowedKeys = expectedKeys(input).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(allowedKeys)) {
        throw new Error(`Rule proposal requires exactly: ${allowedKeys.join(", ")}`);
    }
    if (input.action === "delete") {
        const id = ruleId(input.rule_id, "rule_id");
        const existing = findRule(config.durableRules, input.kind, id);
        if (!existing)
            throw new Error("Rule to delete does not exist in the effective configuration");
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
        const rule = { id, condition: normalizedCondition, categoryId };
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
    const rule = {
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
export async function proposeRule(config, input, store) {
    const normalized = normalizeProposal(config, input);
    if (normalized.summary.length > MAX_APPROVAL_DESCRIPTION_LENGTH) {
        throw new Error(`Rule approval summary must be <= ${MAX_APPROVAL_DESCRIPTION_LENGTH} characters`);
    }
    const proposalId = `proposal_${hash(normalized, 16)}`;
    const stored = { proposalId, ...normalized, createdAt: Date.now() };
    await store.register(proposalId, stored, { ttlMs: RULE_PROPOSAL_TTL_MS });
    return {
        proposal_id: proposalId,
        action: stored.action,
        kind: stored.kind,
        summary: stored.summary,
        ...(stored.rule ? { rule: stored.rule } : {}),
        ...(stored.ruleId ? { rule_id: stored.ruleId } : {}),
    };
}
export async function getRuleProposal(proposalId, store) {
    if (!PROPOSAL_ID_PATTERN.test(proposalId))
        return undefined;
    return store.lookup(proposalId);
}
export async function deleteRuleProposal(proposalId, store) {
    return store.delete(proposalId);
}
export function applyRuleProposal(rules, proposal) {
    if (proposal.action !== "create") {
        const targetId = proposal.action === "delete" ? proposal.ruleId : proposal.rule?.id;
        if (!targetId || !proposal.targetDigest)
            throw new Error("Calendar rule proposal is incomplete");
        const current = findRule(rules, proposal.kind, targetId);
        if (!current)
            throw new Error(`Rule to ${proposal.action} no longer exists`);
        if (ruleDigest(current) !== proposal.targetDigest) {
            throw new Error("Calendar durable rule changed after this proposal; create a fresh proposal");
        }
    }
    const next = {
        classification: rules.classification.map((rule) => ({ ...rule })),
        hygiene: rules.hygiene.map((rule) => ({ ...rule })),
    };
    if (proposal.kind === "classification") {
        const target = next.classification;
        if (proposal.action === "delete") {
            const index = target.findIndex((rule) => rule.id === proposal.ruleId);
            if (index < 0)
                throw new Error("Rule to delete no longer exists");
            target.splice(index, 1);
            return next;
        }
        const rule = proposal.rule;
        if (!rule || !("categoryId" in rule))
            throw new Error("Classification proposal is incomplete");
        if (proposal.action === "replace") {
            const index = target.findIndex((existing) => existing.id === rule.id);
            if (index < 0)
                throw new Error("Rule to replace no longer exists");
            target[index] = rule;
            return next;
        }
        if (target.some((existing) => existing.id === rule.id))
            throw new Error("Equivalent durable rule already exists");
        target.push(rule);
        return next;
    }
    const target = next.hygiene;
    if (proposal.action === "delete") {
        const index = target.findIndex((rule) => rule.id === proposal.ruleId);
        if (index < 0)
            throw new Error("Rule to delete no longer exists");
        target.splice(index, 1);
        return next;
    }
    const rule = proposal.rule;
    if (!rule || !("requireLeader" in rule))
        throw new Error("Hygiene proposal is incomplete");
    if (proposal.action === "replace") {
        const index = target.findIndex((existing) => existing.id === rule.id);
        if (index < 0)
            throw new Error("Rule to replace no longer exists");
        target[index] = rule;
        return next;
    }
    if (target.some((existing) => existing.id === rule.id))
        throw new Error("Equivalent durable rule already exists");
    target.push(rule);
    return next;
}
