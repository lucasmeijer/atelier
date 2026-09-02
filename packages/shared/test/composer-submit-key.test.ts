import { describe, expect, test } from "bun:test";
import { composerSubmitKey } from "../src/index.ts";

function keyEvent(overrides: Partial<Parameters<typeof composerSubmitKey>[0]> = {}): Parameters<typeof composerSubmitKey>[0] {
  return {
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe("composer submit key", () => {
  test("classifies keyboard submit gestures by input behavior", () => {
    expect(composerSubmitKey(keyEvent({ metaKey: true }), false)).toBe("shortcut");
    expect(composerSubmitKey(keyEvent(), true)).toBe("software-keyboard");
    expect(composerSubmitKey(keyEvent(), false)).toBeUndefined();
  });

  test("leaves modified and composing software-keyboard Enter keys available for editing", () => {
    expect(composerSubmitKey(keyEvent({ shiftKey: true }), true)).toBeUndefined();
    expect(composerSubmitKey(keyEvent({ altKey: true }), true)).toBeUndefined();
    expect(composerSubmitKey(keyEvent({ isComposing: true }), true)).toBeUndefined();
  });
});
