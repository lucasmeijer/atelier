import { describe, expect, test } from "bun:test";
import { popupMenuHtml } from "../src/popup/popup-html.ts";

describe("popupMenuHtml", () => {
  test("renders an anchored native popover menu", () => {
    const html = popupMenuHtml({
      id: "work-menu",
      label: "Open Work view",
      placement: "above",
      contentHtml: '<form><button role="menuitem">New terminal</button></form>',
    });

    expect(html).toContain('class="floating-surface popup-menu action-list popup-menu-anchored opens-above"');
    expect(html).toContain('id="work-menu" role="menu" aria-label="Open Work view" popover="auto"');
    expect(html).toContain('<form><button role="menuitem">New terminal</button></form>');
  });

  test("renders a viewport-positioned menu for a caller-owned trigger", () => {
    const html = popupMenuHtml({
      id: "more-menu",
      label: "More",
      className: "mobile-more-menu",
      attributesHtml: 'data-navigation-target="moreMenu"',
      contentHtml: '<button role="menuitem">New file</button>',
    });

    expect(html).toStartWith('<div class="floating-surface popup-menu action-list mobile-more-menu"');
    expect(html).not.toContain("popup-menu-anchored");
    expect(html).toContain('popover="auto" data-navigation-target="moreMenu"');
  });

  test("escapes the menu identity and accessible label", () => {
    const html = popupMenuHtml({
      id: 'models"menu',
      label: "Models <available>",
      contentHtml: "",
    });

    expect(html).toContain('id="models&quot;menu"');
    expect(html).toContain('aria-label="Models &lt;available&gt;"');
  });
});
