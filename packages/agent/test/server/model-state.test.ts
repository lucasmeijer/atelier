import { describe, expect, test } from "bun:test";
import { selectAvailableConfiguredModel, type AgentModelOptionView } from "../../src/server/model-state.ts";

const model = (provider: string, id: string, options: { selected?: boolean; available?: boolean } = {}): AgentModelOptionView => ({
  provider,
  id,
  name: id,
  selected: options.selected ?? false,
  available: options.available ?? true,
});

describe("new workspace model selection", () => {
  test("falls back from a disconnected active model to an available model", () => {
    const models = [
      model("disconnected", "active", { selected: true, available: false }),
      model("connected", "fallback"),
    ];

    expect(selectAvailableConfiguredModel(models)).toEqual({ provider: "connected", id: "fallback" });
    expect(selectAvailableConfiguredModel(models, { provider: "disconnected", id: "active" })).toEqual({ provider: "connected", id: "fallback" });
  });

  test("keeps an available requested model and returns no model when all are disconnected", () => {
    const available = model("connected", "requested");

    expect(selectAvailableConfiguredModel([model("connected", "active", { selected: true }), available], {
      provider: available.provider,
      id: available.id,
    })).toEqual({ provider: "connected", id: "requested" });
    expect(selectAvailableConfiguredModel([model("disconnected", "only", { selected: true, available: false })])).toBeUndefined();
  });
});
