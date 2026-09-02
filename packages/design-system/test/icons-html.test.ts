import { describe, expect, test } from "bun:test";
import { Icons } from "../src/icons/icons-html.ts";

describe("Icons", () => {
  test("provides the shared decorative icon repository", () => {
    expect(Object.keys(Icons)).toEqual([
      "Agent", "Atelier", "Browser", "Close", "CollapseAll", "Code", "Desktop", "Disclosure", "ExpandAll",
      "Files", "More", "Next", "Panel", "Park", "Plus", "Refresh", "Review", "Settings", "Terminal", "Trash", "Workspace",
    ]);
    expect(Icons.Disclosure).toContain('class="disclosure-icon"');
    expect(Object.values(Icons).every((icon) => icon.includes('aria-hidden="true"'))).toBe(true);
  });
});
