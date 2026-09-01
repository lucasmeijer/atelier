import { describe, expect, test } from "bun:test";
import { panelHtml } from "../src/panel/panel-html.ts";

describe("panelHtml", () => {
  test("renders canonical panel regions with caller-owned semantics", () => {
    const html = panelHtml({
      element: { tag: "aside", className: "workspace-pane", attributesHtml: 'aria-label="Workspaces"' },
      headerHtml: "<strong>Atelier</strong>",
      bodyHtml: "<nav>Workspaces</nav>",
    });

    expect(html).toBe('<aside class="panel workspace-pane" aria-label="Workspaces"><header class="panel__header"><strong>Atelier</strong></header><div class="panel__body"><nav>Workspaces</nav></div></aside>');
  });

  test("escapes caller-owned class names", () => {
    const html = panelHtml({
      element: { tag: "section", className: 'settings\" data-unsafe="true' },
      headerHtml: "Settings",
      bodyHtml: "Configuration",
    });

    expect(html).toContain('class="panel settings&quot; data-unsafe=&quot;true"');
  });
});
