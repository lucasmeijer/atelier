import { describe, expect, test } from "bun:test";
import { actionItemHtml } from "../src/action-item/action-item-html.ts";

describe("actionItemHtml", () => {
  test("renders and escapes a canonical single action", () => {
    const html = actionItemHtml({
      kind: "single",
      label: { kind: "text", text: "Files <workspace>" },
      element: { tag: "a", attributesHtml: 'href="/files" aria-current="page"' },
    });

    expect(html).toContain('<a class="action-item action-item__primary" href="/files" aria-current="page">');
    expect(html).toContain('<span class="action-item__label"><span class="action-item__label-text">Files &lt;workspace&gt;</span></span>');
  });

  test("renders compound actions outside the primary action", () => {
    const html = actionItemHtml({
      kind: "compound",
      label: { kind: "text", text: "Server" },
      container: { className: "view-selector", attributesHtml: 'role="presentation"' },
      primary: { tag: "button", attributesHtml: 'type="button" role="tab"' },
      engagedActionsHtml: '<form><button type="submit">Close</button></form>',
    });

    expect(html).toContain('<div class="view-selector action-item" role="presentation">');
    expect(html).toContain('<button class="action-item__primary" type="button" role="tab">');
    expect(html).toContain('<div class="action-item__actions action-item__actions--engaged"><form><button type="submit">Close</button></form></div>');
  });
});
