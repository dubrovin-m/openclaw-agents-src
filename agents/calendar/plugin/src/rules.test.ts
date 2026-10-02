import { describe, expect, it } from "vitest";
import {
  applyRuleProposal,
  getRuleProposal,
  parseDurableRules,
  proposeRule,
  type DurableRules,
} from "./rules.js";
import { VALID_CONFIG } from "./test-fixture.js";

function config(rules: DurableRules = { classification: [], hygiene: [] }) {
  return { ...VALID_CONFIG, durableRules: rules };
}

describe("Calendar durable rules", () => {
  it("normalizes and applies one classification rule", () => {
    const proposal = proposeRule(config(), {
      action: "create",
      kind: "classification",
      condition: "  Purpose   is strategic review  ",
      category_id: "strategy",
    });
    expect(proposal).toMatchObject({
      action: "create",
      kind: "classification",
      rule: { condition: "Purpose is strategic review", categoryId: "strategy" },
    });
    expect(proposal.summary.length).toBeLessThanOrEqual(512);
    const stored = getRuleProposal(proposal.proposal_id);
    expect(stored).toBeDefined();
    expect(applyRuleProposal(config().durableRules, stored!)).toMatchObject({
      classification: [{ condition: "Purpose is strategic review", categoryId: "strategy" }],
      hygiene: [],
    });
  });

  it("rejects an unknown classification category", () => {
    expect(() => proposeRule(config(), {
      action: "create",
      kind: "classification",
      condition: "Purpose is strategic review",
      category_id: "unknown",
    })).toThrow(/configured Calendar leaf category/u);
  });

  it("bounds rule text so native approval can show it in full", () => {
    expect(() => proposeRule(config(), {
      action: "create",
      kind: "classification",
      condition: "x".repeat(321),
      category_id: "strategy",
    })).toThrow(/1-320 characters/u);

    const proposal = proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "x".repeat(320),
      require_leader: false,
      require_agenda: false,
    });
    expect(proposal.summary.length).toBeLessThanOrEqual(512);
    expect(proposal.summary).toContain("x".repeat(320));
  });

  it("creates a bounded hygiene exception and rejects a no-op exception", () => {
    const proposal = proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "Purpose is interview",
      require_leader: false,
      require_agenda: true,
    });
    expect(proposal).toMatchObject({
      rule: {
        condition: "Purpose is interview",
        requireLeader: false,
        requireAgenda: true,
      },
    });
    expect(() => proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "Purpose is ordinary meeting",
      require_leader: true,
      require_agenda: true,
    })).toThrow(/must waive/u);
  });

  it("replaces and deletes only an existing exact rule", () => {
    const initial: DurableRules = {
      classification: [{ id: "class_existing", condition: "Old condition", categoryId: "strategy" }],
      hygiene: [{ id: "hyg_existing", condition: "Interview", requireLeader: false, requireAgenda: false }],
    };
    const replace = proposeRule(config(initial), {
      action: "replace",
      kind: "classification",
      rule_id: "class_existing",
      condition: "New condition",
      category_id: "delivery",
    });
    const replaced = applyRuleProposal(initial, getRuleProposal(replace.proposal_id)!);
    expect(replaced.classification).toEqual([
      { id: "class_existing", condition: "New condition", categoryId: "delivery" },
    ]);

    const remove = proposeRule(config(replaced), {
      action: "delete",
      kind: "hygiene_exception",
      rule_id: "hyg_existing",
    });
    const removed = applyRuleProposal(replaced, getRuleProposal(remove.proposal_id)!);
    expect(removed.hygiene).toEqual([]);
  });

  it("applies independent create proposals even when another rule was committed first", () => {
    const first = proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "Внешняя встреча с партнёром",
      require_leader: false,
      require_agenda: false,
    });
    const second = proposeRule(config(), {
      action: "create",
      kind: "hygiene_exception",
      condition: "Встреча продолжительностью ровно 30 минут",
      require_leader: true,
      require_agenda: false,
    });

    const afterFirst = applyRuleProposal(config().durableRules, getRuleProposal(first.proposal_id)!);
    const afterSecond = applyRuleProposal(afterFirst, getRuleProposal(second.proposal_id)!);

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

  it("allows unrelated changes but fails closed when the targeted rule changed", () => {
    const initial: DurableRules = {
      classification: [{ id: "class_existing", condition: "Old condition", categoryId: "strategy" }],
      hygiene: [],
    };
    const replace = proposeRule(config(initial), {
      action: "replace",
      kind: "classification",
      rule_id: "class_existing",
      condition: "New condition",
      category_id: "delivery",
    });
    const unrelatedChange: DurableRules = {
      classification: initial.classification,
      hygiene: [{ id: "hyg_other", condition: "Other", requireLeader: false, requireAgenda: true }],
    };
    const replaced = applyRuleProposal(unrelatedChange, getRuleProposal(replace.proposal_id)!);
    expect(replaced.classification).toEqual([
      { id: "class_existing", condition: "New condition", categoryId: "delivery" },
    ]);
    expect(replaced.hygiene).toEqual(unrelatedChange.hygiene);

    const targetedChange: DurableRules = {
      classification: [{ id: "class_existing", condition: "Changed elsewhere", categoryId: "strategy" }],
      hygiene: [],
    };
    expect(() => applyRuleProposal(targetedChange, getRuleProposal(replace.proposal_id)!))
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
