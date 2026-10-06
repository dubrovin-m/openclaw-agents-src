import { describe, expect, it, vi } from "vitest";
import entry from "./plugin.js";
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
        state: {
          openKeyedStore: vi.fn(() => ({
            register: vi.fn(),
            lookup: vi.fn(),
            delete: vi.fn(),
          })),
        },
      },
      registerTool(tool: unknown, options?: { name?: string; optional?: boolean }) {
        registrations.push({ tool, options });
      },
      on: vi.fn(),
    };

    entry.register(api as never);

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
});
