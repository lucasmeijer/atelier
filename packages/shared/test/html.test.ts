import { describe, expect, test } from "bun:test";
import { progressButtonHtml } from "../src/html.ts";

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
