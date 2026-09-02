import { describe, expect, test } from "bun:test";
import { progressButtonHtml } from "../src/progress-button/progress-button-html.ts";

const content = {
  initialContent: { kind: "text" as const, text: "Download <update>" },
  progressContent: { kind: "html" as const, html: "<i>Downloading…</i>" },
  variant: "primary" as const,
};

describe("progressButtonHtml", () => {
  test("renders escaped initial content and trusted progress content at a stable width", () => {
    const html = progressButtonHtml({
      ...content,
      id: "update_submit",
      attributesHtml: 'name="update" data-action="updates#start"',
      type: "submit",
      state: "initial",
    });

    expect(html).toContain('id="update_submit"');
    expect(html).toContain('class="button primary progress-button"');
    expect(html).toContain('type="submit" data-progress-state="initial"');
    expect(html).toContain('name="update" data-action="updates#start"');
    expect(html).toContain('data-progress-content="initial">Download &lt;update&gt;');
    expect(html).toContain('data-progress-content="in-progress"><i>Downloading…</i>');
  });

  test("owns disabled and busy semantics while determinate progress runs", () => {
    const html = progressButtonHtml({ ...content, state: "in-progress", progress: 43 });

    expect(html).toContain('data-progress-state="in-progress"');
    expect(html).toContain('style="--button-progress:43"');
    expect(html).toContain(" disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-progress-kind="indeterminate"');
  });

  test("renders indeterminate progress when no measurement is available", () => {
    const html = progressButtonHtml({ ...content, state: "in-progress" });

    expect(html).toContain('data-progress-kind="indeterminate"');
    expect(html).not.toContain("--button-progress");
  });

  test("rejects progress outside the perimeter's range", () => {
    expect(() => progressButtonHtml({ ...content, state: "in-progress", progress: 101 })).toThrow(RangeError);
  });
});
