import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/server/markdown.ts";
import { splitAtelierEmbeds, rewriteSegment } from "../../src/server/rewrite.ts";

describe("renderMarkdown", () => {
  test("paragraphs, bold, inline code", () => {
    const html = renderMarkdown("Hello **world**, see `code`.");
    expect(html).toBe("<p>Hello <strong>world</strong>, see <code>code</code>.</p>");
  });

  test("escapes html", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toContain("&lt;script&gt;");
  });

  test("fenced code blocks are highlighted but markdown is not formatted", () => {
    const html = renderMarkdown("```bash\nls **/work**\n```");
    expect(html.startsWith(`<pre data-lang="bash" class="language-bash"><code>`)).toBe(true);
    expect(html).toContain("**/work**");
    expect(html).not.toContain("<strong>");
  });

  test("fenced code highlighting supports C# aliases", () => {
    const html = renderMarkdown("```cs\npublic class Demo {}\n```");
    expect(html).toContain(`data-lang="cs" class="language-csharp"`);
    expect(html).toContain("hljs-keyword");
  });

  test("lists", () => {
    expect(renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(renderMarkdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  test("headings are kept small", () => {
    expect(renderMarkdown("# Title")).toBe("<h3>Title</h3>");
  });

  test("links only for http(s)", () => {
    expect(renderMarkdown("[x](https://example.com)")).toContain(`href="https://example.com"`);
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href");
  });
});

describe("splitAtelierEmbeds", () => {
  test("splits embed directives outside code", () => {
    expect(splitAtelierEmbeds("before {{atelier:embed /tmp/a.html}} after")).toEqual([
      { type: "text", text: "before " },
      { type: "embed", target: "/tmp/a.html" },
      { type: "text", text: " after" },
    ]);
    expect(splitAtelierEmbeds("`{{atelier:embed /tmp/a.html}}`\n```\n{{atelier:embed /tmp/b.html}}\n```"))
      .toEqual([{ type: "text", text: "`{{atelier:embed /tmp/a.html}}`\n```\n{{atelier:embed /tmp/b.html}}\n```" }]);
  });
});

describe("rewriteSegment", () => {
  test("returns undefined without tokens", () => {
    expect(rewriteSegment("ws", "plain text")).toBeUndefined();
  });

  test("rewrites image file embeds to <img>", () => {
    const html = rewriteSegment("ws", "look: {{atelier:embed /tmp/shot.png}} done")!;
    expect(html).toContain(`data-agent-proxy-app-key-value="file"`);
    expect(html).toContain(`data-agent-proxy-path-value="/tmp/shot.png"`);
    expect(html).toContain(`<img class="agent-media-img"`);
  });

  test("rewrites video file embeds to <video>", () => {
    const html = rewriteSegment("ws", "{{atelier:embed /work/demo.mp4}}")!;
    expect(html).toContain("<video");
    expect(html).toContain("controls");
  });

  test("rewrites localhost url embeds to iframes through the workspace app proxy", () => {
    const html = rewriteSegment("ws", "try {{atelier:embed http://localhost:3000/app?x=1&y=2}}")!;
    expect(html).toContain(`data-agent-proxy-app-key-value="port-3000"`);
    expect(html).toContain(`data-agent-proxy-path-value="/app?x=1&amp;y=2"`);
    expect(html).toContain(`<iframe data-controller="agent-proxy agent-html-preview"`);
  });

  test("rewrites remote url embeds to direct iframes", () => {
    const html = rewriteSegment("ws", "try {{atelier:embed https://example.com/app}}")!;
    expect(html).toContain(`<iframe src="https://example.com/app"`);
  });

  test("escapes other content", () => {
    const html = rewriteSegment("ws", "<b> {{atelier:embed /x.bin}}")!;
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain(`<a class="agent-media-link"`);
    expect(html).toContain(`data-agent-proxy-app-key-value="file"`);
  });
});
