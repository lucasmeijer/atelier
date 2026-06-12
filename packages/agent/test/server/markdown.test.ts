import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/server/markdown.ts";
import { rewriteSegment } from "../../src/server/rewrite.ts";
import { resolveWorkspacePortProxyTarget } from "../../src/server/routes.ts";

describe("renderMarkdown", () => {
  test("paragraphs, bold, inline code", () => {
    const html = renderMarkdown("Hello **world**, see `code`.");
    expect(html).toBe("<p>Hello <strong>world</strong>, see <code>code</code>.</p>");
  });

  test("escapes html", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toContain("&lt;script&gt;");
  });

  test("fenced code blocks are highlighted but markdown is not formatted", () => {
    const html = renderMarkdown("```bash\nls **/repos**\n```");
    expect(html.startsWith(`<pre data-lang="bash" class="language-bash"><code>`)).toBe(true);
    expect(html).toContain("**/repos**");
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

describe("rewriteSegment", () => {
  test("returns undefined without tokens", () => {
    expect(rewriteSegment("ws", "plain text")).toBeUndefined();
  });

  test("rewrites image file embeds to <img>", () => {
    const html = rewriteSegment("ws", "look: {{atelier:embed /tmp/shot.png}} done")!;
    expect(html).toContain(`<img class="agent-media-img" src="/workspaces/ws/agent-files?path=%2Ftmp%2Fshot.png"`);
  });

  test("rewrites video file embeds to <video>", () => {
    const html = rewriteSegment("ws", "{{atelier:embed /repos/demo.mp4}}")!;
    expect(html).toContain("<video");
    expect(html).toContain("controls");
  });

  test("rewrites localhost url embeds to iframes through the workspace port proxy", () => {
    const html = rewriteSegment("ws", "try {{atelier:embed http://localhost:3000/app?x=1&y=2}}")!;
    expect(html).toContain(`<iframe src="/workspaces/ws/agent-port/3000/app?x=1&amp;y=2"`);
  });

  test("rewrites remote url embeds to direct iframes", () => {
    const html = rewriteSegment("ws", "try {{atelier:embed https://example.com/app}}")!;
    expect(html).toContain(`<iframe src="https://example.com/app"`);
  });

  test("escapes other content", () => {
    const html = rewriteSegment("ws", "<b> {{atelier:embed /x.bin}}")!;
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain(`<a class="agent-media-link"`);
  });
});

describe("resolveWorkspacePortProxyTarget", () => {
  test("builds a published preview target in fake mode", async () => {
    const previous = process.env.ATELIER_AGENT_FAKE;
    process.env.ATELIER_AGENT_FAKE = "1";
    try {
      const target = await resolveWorkspacePortProxyTarget("ws", 3000, "app", "?x=1");
      expect(target.toString()).toBe("http://127.0.0.1:3000/app?x=1");
    } finally {
      if (previous === undefined) delete process.env.ATELIER_AGENT_FAKE;
      else process.env.ATELIER_AGENT_FAKE = previous;
    }
  });
});
