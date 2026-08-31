import { describe, expect, test } from "bun:test";
import { activityButtonHtml } from "../src/html.ts";

describe("activity button HTML", () => {
  test("renders an actionable indeterminate state", () => {
    const html = activityButtonHtml({
      initialHtml: "Start sync",
      activeHtml: "Stop sync",
      state: "active",
      variant: "primary",
      id: "sync",
    });

    expect(html).toContain('id="sync" class="button primary activity-button"');
    expect(html).toContain('data-activity-state="active" aria-busy="true"');
    expect(html).toContain('class="activity-button__indicator"');
    expect(html).toContain('data-activity-content="initial">Start sync');
    expect(html).toContain('data-activity-content="active">Stop sync');
    expect(html).not.toContain(" disabled");
  });
});
