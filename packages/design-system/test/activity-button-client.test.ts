import { describe, expect, test } from "bun:test";
import { setActivityButtonState } from "../src/activity-button/activity-button-client.ts";

describe("setActivityButtonState", () => {
  test("keeps activity state, busy semantics, and icon-only naming synchronized", () => {
    const attributes = new Map<string, string>();
    const dataset: DOMStringMap = { activityInitialLabel: "Start sync", activityActiveLabel: "Stop sync" };
    const button = {
      dataset,
      classList: { contains: (name: string) => name === "icon-only" },
      title: "Start sync",
      setAttribute(name: string, value: string) { attributes.set(name, value); },
      removeAttribute(name: string) { attributes.delete(name); },
    };

    setActivityButtonState(button, "active");
    expect(button.dataset.activityState).toBe("active");
    expect(attributes.get("aria-busy")).toBe("true");
    expect(button.title).toBe("Stop sync");
    expect(attributes.get("aria-label")).toBe("Stop sync");

    setActivityButtonState(button, "initial");
    expect(button.dataset.activityState).toBe("initial");
    expect(attributes.has("aria-busy")).toBe(false);
    expect(button.title).toBe("Start sync");
    expect(attributes.get("aria-label")).toBe("Start sync");
  });
});
