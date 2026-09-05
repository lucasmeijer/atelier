import { describe, expect, test } from "bun:test";
import { copyButtonHtml } from "../src/copy-button/copy-button-html.ts";

describe("copyButtonHtml", () => {
  test("renders canonical clipboard feedback and escapes caller content", () => {
    const html = copyButtonHtml({
      label: 'Copy <file> "now"',
      caption: "Copy <file>",
      copyText: 'value"',
      attributesHtml: 'data-file-target="copy"',
    });

    expect(html).toContain('class="button secondary copy-button transient-feedback"');
    expect(html).toContain('title="Copy &lt;file&gt; &quot;now&quot;"');
    expect(html).toContain('data-copy-text="value&quot;"');
    expect(html).toContain('data-transient-feedback-initial-label="Copy &lt;file&gt; &quot;now&quot;"');
    expect(html).toContain("data-transient-feedback-keep-enabled");
    expect(html).toContain('<span>Copy &lt;file&gt;</span>');
  });

  test("defaults to an icon-only control", () => {
    expect(copyButtonHtml({ label: "Copy" })).toContain('class="button secondary icon-only copy-button transient-feedback"');
  });
});
