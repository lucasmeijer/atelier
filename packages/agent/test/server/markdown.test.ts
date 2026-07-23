import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/server/markdown.ts";
import { renderAtelierFileLink, splitAtelierEmbeds, rewriteSegment } from "../../src/server/rewrite.ts";

const atelierLinks = {
  rewriteLink: (label: string, href: string) => renderAtelierFileLink("work 1", label, href),
};

describe("renderMarkdown", () => {
  test("paragraphs, bold, inline code", () => {
    const html = renderMarkdown("Hello **world**, see `code`.");
    expect(html).toBe("<p>Hello <strong>world</strong>, see <code>code</code>.</p>");
  });

  test("escapes html", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toContain("&lt;script&gt;");
  });

  test("fenced code blocks are highlighted and copyable but markdown is not formatted", () => {
    const html = renderMarkdown("```bash\nls **/work**\n```");
    expect(html.startsWith(`<div class="agent-code-block" data-controller="agent-code-copy">`)).toBe(true);
    expect(html).toContain(`data-action="agent-code-copy#copy"`);
    expect(html).toContain(`<pre data-lang="bash" class="language-bash"><code data-agent-code-copy-target="code">`);
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

  test("an ordered list can use 1 for every Markdown marker with blank lines between items", () => {
    expect(renderMarkdown("1. one\n\n1. two\n\n1. three\n\n1. four")).toBe(
      "<ol><li>one</li><li>two</li><li>three</li><li>four</li></ol>",
    );
  });

  test("GitHub-style tables", () => {
    const html = renderMarkdown([
      "| Provider | Model ID |",
      "|---|---|",
      "| Kimi For Coding | `k3` |",
      "| OpenRouter | `moonshotai/kimi-k3` |",
    ].join("\n"));
    expect(html).toBe('<div class="agent-table-scroll"><table><thead><tr><th>Provider</th><th>Model ID</th></tr></thead><tbody><tr><td>Kimi For Coding</td><td><code>k3</code></td></tr><tr><td>OpenRouter</td><td><code>moonshotai/kimi-k3</code></td></tr></tbody></table></div>');
  });

  test("table cells support pipes in inline code and escaped pipes", () => {
    const html = renderMarkdown("Name | Value\n--- | ---\nCode | `a|b`\nText | a\\|b");
    expect(html).toContain("<td><code>a|b</code></td>");
    expect(html).toContain("<td>a|b</td>");
  });

  test("does not mistake ordinary pipe-delimited text for a table", () => {
    expect(renderMarkdown("one | two\nthree | four")).toBe("<p>one | two\nthree | four</p>");
  });

  test("headings are kept small", () => {
    expect(renderMarkdown("# Title")).toBe("<h3>Title</h3>");
  });

  test("renders a plain Atelier file-link label", () => {
    const html = renderMarkdown("[example.ts:42](atelier://file/work/src/example.ts?line=42&column=3)", atelierLinks);
    expect(html).toContain(`>example.ts:42</a>`);
    expect(html).toContain(`/workspaces/work%201/file-editor/open?path=%2Fwork%2Fsrc%2Fexample.ts&amp;line=42&amp;column=3`);
    expect(html).toContain(`data-turbo-stream="true"`);
  });

  test("renders inline code in an Atelier file-link label", () => {
    const html = renderMarkdown("[`render.ts:55`](atelier://file/work/packages/files/src/server/render.ts?line=55&column=1)", atelierLinks);
    expect(html).toContain("><code>render.ts:55</code></a>");
    expect(html).toContain("line=55&amp;column=1");
  });

  test("does not rewrite Atelier links inside inline code", () => {
    const html = renderMarkdown("`[render.ts:55](atelier://file/work/render.ts?line=55&column=1)`", atelierLinks);
    expect(html).toBe("<p><code>[render.ts:55](atelier://file/work/render.ts?line=55&amp;column=1)</code></p>");
    expect(html).not.toContain("data-turbo-stream");
  });

  test("escapes special characters in code-formatted Atelier link labels", () => {
    const html = renderMarkdown("[`<tag>&\"`](atelier://file/work/render.ts)", atelierLinks);
    expect(html).toContain("<code>&lt;tag&gt;&amp;&quot;</code>");
  });

  test("keeps HTTP-link behavior unchanged", () => {
    expect(renderMarkdown("[x](https://example.com)")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener">x</a></p>',
    );
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
