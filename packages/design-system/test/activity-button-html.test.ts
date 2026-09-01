import { describe, expect, test } from "bun:test";
import { activityButtonHtml } from "../src/activity-button/activity-button-html.ts";

const content = {
  initialContent: { kind: "text" as const, text: "Start <sync>" },
  activeContent: { kind: "html" as const, html: "<i>Stop sync</i>" },
};

describe("activityButtonHtml", () => {
  test("renders escaped initial content and trusted active content at a stable width", () => {
    const html = activityButtonHtml({
      ...content,
      id: "sync_submit",
      variant: "primary",
      attributesHtml: 'name="sync" data-action="sync#toggle"',
      type: "submit",
      state: "initial",
    });

    expect(html).toContain('id="sync_submit"');
    expect(html).toContain('class="button primary activity-button"');
    expect(html).toContain('type="submit" data-activity-state="initial"');
    expect(html).toContain('name="sync" data-action="sync#toggle"');
    expect(html).toContain('data-activity-content="initial">Start &lt;sync&gt;');
    expect(html).toContain('data-activity-content="active"><i>Stop sync</i>');
    expect(html).not.toContain('aria-busy="true"');
  });

  test("keeps active actions enabled while exposing busy semantics", () => {
    const html = activityButtonHtml({ ...content, variant: "secondary", state: "active" });

    expect(html).toContain('data-activity-state="active" aria-busy="true"');
    expect(html).not.toContain(" disabled");
  });

  test("owns icon-only geometry and state-specific accessible naming", () => {
    const initial = activityButtonHtml({ ...content, variant: "danger", state: "initial", iconOnly: true, initialLabel: "Start sync", activeLabel: "Stop sync" });
    const active = activityButtonHtml({ ...content, variant: "danger", state: "active", iconOnly: true, initialLabel: "Start sync", activeLabel: "Stop sync" });

    expect(initial).toContain('class="button danger icon-only activity-button"');
    expect(initial).toContain('title="Start sync" aria-label="Start sync"');
    expect(initial).toContain('data-activity-initial-label="Start sync" data-activity-active-label="Stop sync"');
    expect(active).toContain('title="Stop sync" aria-label="Stop sync"');
  });
});
