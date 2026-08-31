import { describe, expect, test } from "bun:test";
import { activityButtonHtml, progressButtonHtml } from "../src/html.ts";

describe("progress button HTML", () => {
  test("renders required initial and in-progress content with an optional finish state", () => {
    const html = progressButtonHtml({
      initialHtml: "Update Atelier",
      inProgressHtml: "<i>Updating…</i>",
      state: "in-progress",
      progress: 43,
      variant: "primary",
      type: "submit",
      id: "update_submit",
    });

    expect(html).toContain('id="update_submit" class="button primary progress-button"');
    expect(html).toContain('data-progress-state="in-progress"');
    expect(html).toContain('style="--button-progress:43"');
    expect(html).toContain('disabled aria-busy="true"');
    expect(html).toContain('data-progress-content="initial">Update Atelier');
    expect(html).toContain('data-progress-content="in-progress"><i>Updating…</i>');
    expect(html).not.toContain('data-progress-content="finish"');

  });

  test("renders caller-supplied finish content", () => {
    expect(progressButtonHtml({ initialHtml: "Start", inProgressHtml: "Working", finishHtml: "Done", state: "finish", variant: "primary" })).toContain('data-progress-content="finish">Done');
  });
});

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
