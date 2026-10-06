import { describe, expect, it, vi } from "vitest";
import entry, { ruleProposalStore } from "./plugin.js";
import { getRuleProposal, proposeRule } from "./rules.js";
import { VALID_CONFIG } from "./test-fixture.js";

const EXPECTED_TOOL_NAMES = [
  "calendar_config_get",
  "calendar_review_window",
  "calendar_analyze",
  "calendar_rule_propose",
  "calendar_rule_commit",
  "calendar_provider_list_events",
  "calendar_provider_get_event",
  "calendar_provider_get_labels",
  "calendar_provider_set_label",
  "calendar_provider_sync_labels",
].sort();

describe("Calendar plugin registration", () => {
  it("keeps every bounded Calendar tool directly model-visible", () => {
    const registrations: Array<{ tool: unknown; options?: { name?: string; optional?: boolean } }> = [];
    const api = {
      pluginConfig: VALID_CONFIG,
      runtime: {
        config: {
          current: vi.fn(() => ({ plugins: { entries: { "calendar-analytics": { config: VALID_CONFIG } } } })),
          mutateConfigFile: vi.fn(),
        },
      },
      registerTool(tool: unknown, options?: { name?: string; optional?: boolean }) {
        registrations.push({ tool, options });
      },
      on: vi.fn(),
    };

    entry.register(api as never);

    expect("state" in api.runtime).toBe(false);
    expect(registrations).toHaveLength(EXPECTED_TOOL_NAMES.length);
    expect(registrations.map(({ options }) => options?.name).sort()).toEqual(EXPECTED_TOOL_NAMES);

    for (const registration of registrations) {
      expect(registration.options?.optional).toBe(true);
      expect(typeof registration.tool).toBe("function");
      const runtimeTool = (registration.tool as (context: object) => unknown)({});
      expect(runtimeTool).toMatchObject({
        name: registration.options?.name,
        catalogMode: "direct-only",
      });
    }
  });

  it("shares staged proposals across independent runtime-config store handles without trusted plugin state", async () => {
    const backing = {
      root: {
        plugins: {
          entries: {
            "calendar-analytics": {
              config: structuredClone(VALID_CONFIG) as Record<string, unknown>,
            },
          },
        },
      },
    };
    const makeApi = () => ({
      runtime: {
        config: {
          current: () => structuredClone(backing.root),
          async mutateConfigFile(options: { mutate: (draft: typeof backing.root) => unknown }) {
            const draft = structuredClone(backing.root);
            const result = options.mutate(draft);
            backing.root = draft;
            return { result, followUp: { mode: "none", requiresRestart: false } };
          },
        },
      },
    });

    const proposerStore = ruleProposalStore(makeApi() as never);
    const approvalStore = ruleProposalStore(makeApi() as never);
    const proposal = await proposeRule({
      ...VALID_CONFIG,
      durableRules: { classification: [], hygiene: [] },
    }, {
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
});
