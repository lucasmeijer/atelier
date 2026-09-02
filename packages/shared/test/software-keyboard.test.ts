import { describe, expect, test } from "bun:test";
import { softwareKeyboardVisible } from "../src/software-keyboard.ts";

describe("software keyboard policy", () => {
  test("requires focused text entry and substantial viewport occlusion", () => {
    expect(softwareKeyboardVisible(844, 500, true, true)).toBe(true);
    expect(softwareKeyboardVisible(844, 500, false, true)).toBe(false);
    expect(softwareKeyboardVisible(844, 790, true, true)).toBe(false);
    expect(softwareKeyboardVisible(844, 500, true, false)).toBe(false);
  });
});
