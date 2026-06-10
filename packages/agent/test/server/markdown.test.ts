import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/server/markdown.ts";
import { rewriteSegment } from "../../src/server/rewrite.ts";

describe("renderMarkdown", () => {
  test("paragraphs, bold, inline code", () => {
    const html = renderMarkdown("Hello **world**, see `code`.");
    expect(html).toBe("<p>Hello <strong>world</strong>, see <code>code</code>.</p>");
  });

  test("escapes html", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toContain("&lt;script&gt;");
  });

  test("fenced code blocks are not formatted", () => {
    const html = renderMarkdown("```bash\nls **/repos**\n```");
    expect(html).toBe(`<pre data-lang="bash"><code>ls **/repos**</code></pre>`);
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

describe("rewriteSegment", () => {
  test("returns undefined without tokens", () => {
    expect(rewriteSegment("ws", "plain text")).toBeUndefined();
  });

  test("rewrites image file references to <img>", () => {
    const html = rewriteSegment("ws", "look: atelier://file//tmp/shot.png done")!;
    expect(html).toContain(`<img class="agent-media-img" src="/workspaces/ws/agent-files?path=%2Ftmp%2Fshot.png"`);
  });

  test("rewrites video file references to <video>", () => {
    const html = rewriteSegment("ws", "atelier://file//repos/demo.mp4")!;
    expect(html).toContain("<video");
    expect(html).toContain("controls");
  });

  test("rewrites ports to iframes", () => {
    const html = rewriteSegment("ws", "try atelier://port/3000/app")!;
    expect(html).toContain(`<iframe src="/workspaces/ws/agent-port/3000/app"`);
  });

  test("escapes other content", () => {
    const html = rewriteSegment("ws", "<b> atelier://file//x.bin")!;
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain(`<a class="agent-media-link"`);
  });
});
