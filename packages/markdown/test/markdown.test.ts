import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/index.ts";

describe("renderMarkdown", () => {
  test("paragraphs, emphasis, and inline code", () => {
    expect(renderMarkdown("work 1", "Hello **world**, see `code` and *emphasis*.")).toBe(
      "<p>Hello <strong>world</strong>, see <code>code</code> and <em>emphasis</em>.</p>",
    );
  });

  test("escapes raw HTML", () => {
    const html = renderMarkdown("work 1", '<script>alert(1)</script><div onclick="bad()">x</div>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;div onclick=&quot;bad()&quot;&gt;");
    expect(html).not.toContain("<script>");
  });

  test("fenced code blocks are highlighted and copyable but Markdown is not formatted", () => {
    const html = renderMarkdown("work 1", "```bash\nls **/work**\n```");
    expect(html.startsWith(`<div class="agent-code-block" data-controller="agent-code-copy">`)).toBe(true);
    expect(html).toContain(`data-action="agent-code-copy#copy"`);
    expect(html).toContain(`<pre data-lang="bash" class="language-bash"><code data-agent-code-copy-target="code">`);
    expect(html).toContain("/work");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<strong>");
  });

  test("fenced code highlighting supports C# aliases", () => {
    const html = renderMarkdown("work 1", "```cs\npublic class Demo {}\n```");
    expect(html).toContain(`data-lang="cs" class="language-csharp"`);
    expect(html).toContain("syntax-keyword");
  });

  test("GitHub-style tables receive a horizontal scroll container", () => {
    const html = renderMarkdown("work 1", [
      "| Provider | Model ID |",
      "|---|---|",
      "| Kimi For Coding | `k3` |",
      "| OpenRouter | `moonshotai/kimi-k3` |",
    ].join("\n"));
    expect(html).toContain('<div class="agent-table-scroll"><table>');
    expect(html).toContain("<thead>");
    expect(html).toContain("<td><code>k3</code></td>");
    expect(html.endsWith("</table></div>")).toBe(true);
  });

  test("preserves semantic heading levels", () => {
    const html = renderMarkdown("work 1", "# Title\n\n#### Detail");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h4>Detail</h4>");
  });

  test("renders Atelier file links through the Files view", () => {
    const html = renderMarkdown("work 1", "[example.ts:42](atelier://file/work/src/example.ts?line=42&column=3)");
    expect(html).toContain(">example.ts:42</a>");
    expect(html).toContain("/workspaces/work%201/files-view/open?path=%2Fwork%2Fsrc%2Fexample.ts&amp;line=42&amp;column=3");
    expect(html).toContain(`data-turbo-stream="true"`);
  });

  test("renders files outside /work and normal inline Markdown in labels", () => {
    const html = renderMarkdown("work 1", "[Open `/tmp/plan.md`](atelier://file/tmp/plan.md)");
    expect(html).toContain(">Open <code>/tmp/plan.md</code></a>");
    expect(html).toContain("files-view/open?path=%2Ftmp%2Fplan.md");
  });

  test("opens relative file links from the rendered Markdown file", () => {
    const html = renderMarkdown(
      "work 1",
      "[Guide](../guides/getting%20started.md#setup) [Config](./config.ts)",
      { sourcePath: "/work/docs/reference/README.md" },
    );
    expect(html).toContain("files-view/open?path=%2Fwork%2Fdocs%2Fguides%2Fgetting+started.md");
    expect(html).toContain("files-view/open?path=%2Fwork%2Fdocs%2Freference%2Fconfig.ts");
    expect(html.match(/data-turbo-stream="true"/g)).toHaveLength(2);
  });

  test("leaves same-document anchors as preview links", () => {
    const html = renderMarkdown("work 1", "[Setup](#setup)", { sourcePath: "/work/README.md" });
    expect(html).toContain('href="#setup"');
    expect(html).not.toContain("files-view/open");
  });

  test("does not rewrite Atelier links inside inline code", () => {
    const html = renderMarkdown("work 1", "`[render.ts:55](atelier://file/work/render.ts?line=55&column=1)`");
    expect(html).toContain("<code>[render.ts:55](atelier://file/work/render.ts?line=55&amp;column=1)</code>");
    expect(html).not.toContain("data-turbo-stream");
  });

  test("escapes special characters in code-formatted link labels", () => {
    const html = renderMarkdown("work 1", "[`<tag>&\"`](atelier://file/work/render.ts)");
    expect(html).toContain("<code>&lt;tag&gt;&amp;&quot;</code>");
  });

  test("routes eligible workspace-local links through their canonical preview", () => {
    const html = renderMarkdown("work-1", "[app](http://localhost:3004/path?x=1#top)");
    expect(html).toContain(`href="/workspaces/work-1/ports/3004/path?x=1#top"`);
    expect(html).toContain(`target="_blank"`);
  });

  test("opens HTTP links in a new tab and rejects unsafe links", () => {
    const html = renderMarkdown("work 1", "[x](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(renderMarkdown("work 1", "[x](javascript:alert(1))")).not.toContain("href");
  });

  test("accepts 0.0.0.0 as an explicit local preview embed alias", () => {
    const html = renderMarkdown("work-1", "![](atelier-embed:http://0.0.0.0:3000/demo)");
    expect(html).toContain(`data-agent-proxy-app-key-value="port-3000"`);
    expect(html).toContain(`data-agent-proxy-path-value="/demo"`);
  });

  test("renders Atelier embeds from the custom image URL anywhere in text", () => {
    const html = renderMarkdown("work 1", "before ![](atelier-embed:/tmp/shot.png) after");
    expect(html).toContain(`data-agent-proxy-app-key-value="file"`);
    expect(html).toContain(`data-agent-proxy-path-value="/tmp/shot.png"`);
    expect(html).toContain(`<img class="agent-media-img"`);
    expect(html).not.toContain(`<a class="agent-media-link"`);
    expect(html).not.toContain(`target="_blank"`);
    expect(html).toContain("before ");
    expect(html).toContain(" after");
  });

  test("renders video, local application, and remote URL embeds", () => {
    const video = renderMarkdown("work 1", "![](atelier-embed:/work/demo.mp4)");
    expect(video).toContain("<video");
    expect(video).toContain("controls");

    const local = renderMarkdown("work 1", "![](atelier-embed:http://localhost:3000/app?x=1&y=2)");
    expect(local).toContain(`data-agent-proxy-app-key-value="port-3000"`);
    expect(local).toContain(`data-agent-proxy-path-value="/app?x=1&amp;y=2"`);
    expect(local).toContain(`<iframe data-controller="agent-proxy agent-html-preview"`);

    const remote = renderMarkdown("work 1", "![](atelier-embed:https://example.com/app)");
    expect(remote).toContain(`<iframe src="https://example.com/app"`);
  });

  test("does not render embed syntax inside code", () => {
    const inline = renderMarkdown("work 1", "`![](atelier-embed:/tmp/a.png)`");
    const fenced = renderMarkdown("work 1", "```markdown\n![](atelier-embed:/tmp/a.png)\n```");
    expect(inline).not.toContain("agent-media-img");
    expect(fenced).not.toContain("agent-media-img");
  });


  test("ordinary Markdown images retain their normal behavior", () => {
    expect(renderMarkdown("work 1", "![alt](https://example.com/a.png)")).toContain('<img src="https://example.com/a.png" alt="alt">');
  });
});
