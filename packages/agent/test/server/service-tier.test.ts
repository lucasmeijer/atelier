import { describe, expect, test } from "bun:test";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelRuntimeWithServiceTiers, parseAgentServiceTier, serviceTierFromBranch, supportsFastMode } from "../../src/server/service-tier.ts";

describe("agent service tiers", () => {
  test("recognizes only the Codex inference provider", () => {
    expect(supportsFastMode("openai-codex")).toBe(true);
    expect(supportsFastMode("openai")).toBe(false);
    expect(supportsFastMode("anthropic")).toBe(false);
  });

  test("uses explicit Standard for every value except priority", () => {
    expect(parseAgentServiceTier("priority")).toBe("priority");
    expect(parseAgentServiceTier("default")).toBe("default");
    expect(parseAgentServiceTier(undefined)).toBe("default");
  });

  test("the coding-agent stream path injects and records the tier at request dispatch", async () => {
    let transform: NonNullable<SimpleStreamOptions["onPayload"]> | undefined;
    const runtime = {
      streamSimple: (_model: unknown, _context: unknown, options: SimpleStreamOptions | undefined) => {
        transform = options?.onPayload;
        return {};
      },
    };
    const recorded: Array<[string, string]> = [];
    // SAFETY: this test double exercises only the streamSimple method intercepted by modelRuntimeWithServiceTiers.
    const wrapped = modelRuntimeWithServiceTiers(runtime as ModelRuntime, { get: async () => "priority" }, async (provider, serviceTier) => { recorded.push([provider, serviceTier]); });
    const model = { provider: "openai-codex", id: "gpt", api: "openai-codex-responses" };
    // SAFETY: the stream wrapper only reads provider metadata from this focused model fixture.
    wrapped.streamSimple(model as never, { messages: [] });

    expect(await transform?.({ model: "gpt", input: [] }, model as never)).toEqual({ model: "gpt", input: [], service_tier: "priority" });
    expect(recorded).toEqual([["openai-codex", "priority"]]);
  });

  test("restores the latest provider-specific value from the active branch", () => {
    const entries = [
      { type: "custom" as const, id: "1", parentId: null, timestamp: "", customType: "atelier.service-tier", data: { provider: "openai-codex", serviceTier: "priority" } },
      { type: "custom" as const, id: "2", parentId: "1", timestamp: "", customType: "atelier.service-tier", data: { provider: "other", serviceTier: "priority" } },
      { type: "custom" as const, id: "3", parentId: "2", timestamp: "", customType: "atelier.service-tier", data: { provider: "openai-codex", serviceTier: "default" } },
    ];
    expect(serviceTierFromBranch(entries, "openai-codex")).toBe("default");
    expect(serviceTierFromBranch(entries, "other")).toBe("priority");
    expect(serviceTierFromBranch(entries, "missing")).toBeUndefined();
  });
});
