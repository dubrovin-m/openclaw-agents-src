import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import entry from "./plugin.js";

type Registered = {
  definition: unknown;
  options: unknown;
};

function registrations() {
  const registered: Registered[] = [];
  (entry as any).register({
    pluginConfig: { databasePath: "/tmp/training-plugin-contract-test.sqlite3" },
    registerTool(definition: unknown, options: unknown) {
      registered.push({ definition, options });
    },
  });
  return registered;
}

describe("Training plugin contract", () => {
  it("exposes one unique tool per configured allowlist entry", () => {
    const metadata = getToolPluginMetadata(entry);
    expect(metadata).toBeTruthy();
    const names = metadata!.tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);

    const here = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.resolve(here, "../../config/training-tools.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { allow: string[] };
    expect(new Set(config.allow)).toEqual(new Set(names));
  });

  it("does not instantiate Training tools for a non-owner or another agent", () => {
    for (const registration of registrations()) {
      expect(typeof registration.definition).toBe("function");
      const factory = registration.definition as (context: unknown) => unknown;
      expect(factory({
        agentId: "training",
        senderIsOwner: false,
      })).toBeNull();
      expect(factory({
        agentId: "other",
        senderIsOwner: true,
      })).toBeNull();
    }
  });

  it("requires a live invocation guard before a mutation can execute", async () => {
    const metadata = getToolPluginMetadata(entry)!;
    const regs = registrations();
    const index = metadata.tools.findIndex((tool) => tool.name === "training_session_start");
    expect(index).toBeGreaterThanOrEqual(0);

    const factory = regs[index]!.definition as (context: unknown) => any;
    const tool = factory({
      agentId: "training",
      senderIsOwner: true,
    });
    expect(tool).toBeTruthy();

    await expect(tool.execute("call-1", {
      timezone_at_start: "Europe/Moscow",
      local_date: "2026-10-06",
    })).rejects.toThrow(/mutation authority is unavailable/);
  });

  it("instantiates read tools for the owner on the Training agent", () => {
    const metadata = getToolPluginMetadata(entry)!;
    const regs = registrations();
    const index = metadata.tools.findIndex((tool) => tool.name === "training_status");
    const factory = regs[index]!.definition as (context: unknown) => any;
    const tool = factory({
      agentId: "training",
      senderIsOwner: true,
    });
    expect(tool?.name).toBe("training_status");
  });
});
