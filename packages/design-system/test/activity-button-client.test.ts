import { describe, expect, test } from "bun:test";
import { setActivityButtonState } from "../src/activity-button/activity-button-client.ts";

describe("setActivityButtonState", () => {
  test("keeps activity state and busy semantics synchronized", () => {
    const attributes = new Map<string, string>();
    // SAFETY: This focused fake implements every HTMLButtonElement member used by the state helper.
    const button = {
      // SAFETY: The helper only writes the activityState string property.
      dataset: {} as DOMStringMap,
      setAttribute(name: string, value: string) { attributes.set(name, value); },
      removeAttribute(name: string) { attributes.delete(name); },
    } as HTMLButtonElement;

    setActivityButtonState(button, "active");
    expect(button.dataset.activityState).toBe("active");
    expect(attributes.get("aria-busy")).toBe("true");

    setActivityButtonState(button, "initial");
    expect(button.dataset.activityState).toBe("initial");
    expect(attributes.has("aria-busy")).toBe(false);
  });
});
