import { describe, expect, it } from "vitest";
import {
  applyRuleProposal,
  getRuleProposal,
  parseDurableRules,
  proposeRule,
  type DurableRules,
  type RuleProposalStore,
  type StoredRuleProposal,
} from "./rules.js";
import { VALID_CONFIG } from "./test-fixture.js";

function config(rules: DurableRules = { classification: [], hygiene: [] }) {
  return { ...VALID_CONFIG, durableRules: rules };
}

function proposalStore(backing = new Map<string, StoredRuleProposal>()): RuleProposalStore {
  return {
    async register(key, value) {
      backing.set(key, structuredClone(value));
    },
    async lookup(key) {
      const value = backing.get(key);
      return value ? structuredClone(value) : undefined;
    },
    async delete(key) {
      return backing.delete(key);
    },
  };
}

describe("Calendar durable rules", () => {
  it("normalizes, persists, and applies one classification rule", async () => {
    const store = proposalStore();
    const proposal = await proposeRule(config(), {
      action: "create",
      kind: "classification",
      condition: "  Purpose   is strategic review  ",
      category_id: "strategy",
    }, store);
    expect(proposal).toMatchObject({
      action: "create",
      kind: "classification",
      rule: { condition: "Purpose is strategic review", categoryId: "strategy" },
    });
    expect(proposal.summary.length).toBeLessThanOrEqual(512);
    const stored = await getRuleProposal(proposal.proposal_id, store);
    expect(stored).toBeDefined();
    expect(applyRuleProposal(config().durableRules, stored!)).toMatchObject({
      classification: [{ condition: "Purpose is strategic review", categoryId: "strategy" }],
      hygiene: [],
    });
  });

  it("keeps proposals visible across independent store handles over shared durable backing", async () => {
    const backing = new Map<string, StoredRuleProposal>();
    const proposerStore = proposalStore(backing);
    const approvalStore = proposalStore(backing);
    const proposal = await proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "Purpose is interview",
      require_leader: false,
      require_agenda: false,
    }, proposerStore);

    await expect(getRuleProposal(proposal.proposal_id, approvalStore)).resolves.toMatchObject({
      proposalId: proposal.proposal_id,
      summary: proposal.summary,
    });
  });

  it("rejects an unknown classification category", async () => {
    await expect(proposeRule(config(), {
      action: "create",
      kind: "classification",
      condition: "Purpose is strategic review",
      category_id: "unknown",
    }, proposalStore())).rejects.toThrow(/configured Calendar leaf category/u);
  });

  it("bounds rule text so native approval can show it in full", async () => {
    await expect(proposeRule(config(), {
      action: "create",
      kind: "classification",
      condition: "x".repeat(321),
      category_id: "strategy",
    }, proposalStore())).rejects.toThrow(/1-320 characters/u);

    const proposal = await proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "x".repeat(320),
      require_leader: false,
      require_agenda: false,
    }, proposalStore());
    expect(proposal.summary.length).toBeLessThanOrEqual(512);
    expect(proposal.summary).toContain("x".repeat(320));
  });

  it("creates a bounded hygiene exception and rejects a no-op exception", async () => {
    const proposal = await proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "Purpose is interview",
      require_leader: false,
      require_agenda: true,
    }, proposalStore());
    expect(proposal).toMatchObject({
      rule: {
        condition: "Purpose is interview",
        requireLeader: false,
        requireAgenda: true,
      },
    });
    await expect(proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "Purpose is ordinary meeting",
      require_leader: true,
      require_agenda: true,
    }, proposalStore())).rejects.toThrow(/must waive/u);
  });

  it("replaces and deletes only an existing exact rule", async () => {
    const store = proposalStore();
    const initial: DurableRules = {
      classification: [{ id: "class_existing", condition: "Old condition", categoryId: "strategy" }],
      hygiene: [{ id: "hyg_existing", condition: "Interview", requireLeader: false, requireAgenda: false }],
    };
    const replace = await proposeRule(config(initial), {
      action: "replace",
      kind: "classification",
      rule_id: "class_existing",
      condition: "New condition",
      category_id: "delivery",
    }, store);
    const replaceStored = await getRuleProposal(replace.proposal_id, store);
    const replaced = applyRuleProposal(initial, replaceStored!);
    expect(replaced.classification).toEqual([
      { id: "class_existing", condition: "New condition", categoryId: "delivery" },
    ]);

    const remove = await proposeRule(config(replaced), {
      action: "delete",
      kind: "hygiene_exception",
      rule_id: "hyg_existing",
    }, store);
    const removeStored = await getRuleProposal(remove.proposal_id, store);
    const removed = applyRuleProposal(replaced, removeStored!);
    expect(removed.hygiene).toEqual([]);
  });

  it("applies independent create proposals even when another rule was committed first", async () => {
    const store = proposalStore();
    const first = await proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "Внешняя встреча с партнёром",
      require_leader: false,
      require_agenda: false,
    }, store);
    const second = await proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "Встреча продолжительностью ровно 30 минут",
      require_leader: true,
      require_agenda: false,
    }, store);

    const firstStored = await getRuleProposal(first.proposal_id, store);
    const secondStored = await getRuleProposal(second.proposal_id, store);
    const afterFirst = applyRuleProposal(config().durableRules, firstStored!);
    const afterSecond = applyRuleProposal(afterFirst, secondStored!);

    expect(afterSecond.hygiene.map((rule) => ({
      condition: rule.condition,
      requireLeader: rule.requireLeader,
      requireAgenda: rule.requireAgenda,
    }))).toEqual([
      {
        condition: "Внешняя встреча с партнёром",
        requireLeader: false,
        requireAgenda: false,
      },
      {
        condition: "Встреча продолжительностью ровно 30 минут",
        requireLeader: true,
        requireAgenda: false,
      },
    ]);
  });

  it("allows unrelated changes but fails closed when the targeted rule changed", async () => {
    const store = proposalStore();
    const initial: DurableRules = {
      classification: [{ id: "class_existing", condition: "Old condition", categoryId: "strategy" }],
      hygiene: [],
    };
    const replace = await proposeRule(config(initial), {
      action: "replace",
      kind: "classification",
      rule_id: "class_existing",
      condition: "New condition",
      category_id: "delivery",
    }, store);
    const stored = await getRuleProposal(replace.proposal_id, store);
    const unrelatedChange: DurableRules = {
      classification: initial.classification,
      hygiene: [{ id: "hyg_other", condition: "Other", requireLeader: false, requireAgenda: true }],
    };
    const replaced = applyRuleProposal(unrelatedChange, stored!);
    expect(replaced.classification).toEqual([
      { id: "class_existing", condition: "New condition", categoryId: "delivery" },
    ]);
    expect(replaced.hygiene).toEqual(unrelatedChange.hygiene);

    const targetedChange: DurableRules = {
      classification: [{ id: "class_existing", condition: "Changed elsewhere", categoryId: "strategy" }],
      hygiene: [],
    };
    expect(() => applyRuleProposal(targetedChange, stored!))
      .toThrow(/changed after this proposal/u);
  });

  it("rejects duplicate ids and unsupported persisted fields", () => {
    expect(() => parseDurableRules({
      classification: [{ id: "shared_rule", condition: "One", categoryId: "strategy" }],
      hygiene: [{ id: "shared_rule", condition: "Two", requireLeader: false, requireAgenda: true }],
    })).toThrow(/ids must be unique/u);

    expect(() => parseDurableRules({
      classification: [{ id: "class_rule", condition: "One", categoryId: "strategy", title: "nope" }],
      hygiene: [],
    })).toThrow(/unsupported fields/u);
  });
});
