import { describe, expect, test } from "bun:test";
import { destructiveConfirmationHtml } from "../src/destructive-confirmation/destructive-confirmation-html.ts";

describe("destructiveConfirmationHtml", () => {
  test("renders an inert decision with escaped caller captions", () => {
    const html = destructiveConfirmationHtml({
      trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: "×", label: "Close" } },
      confirmCaption: "Yes, close <now>",
      cancelCaption: "Oops & stay",
    });

    expect(html).toStartWith('<div class="destructive-confirmation" data-controller="destructive-confirmation">');
    expect(html).toContain('<div class="destructive-confirmation__decision" inert>');
  });

  test("supports a distinct confirmation form action", () => {
    const html = destructiveConfirmationHtml({
      trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Remove" } },
      confirmCaption: "Remove",
      cancelCaption: "Cancel",
      confirmFormAction: '/items/one/delete?returnTo=a&b="quoted"',
    });

    expect(html).toContain('formaction="/items/one/delete?returnTo=a&amp;b=&quot;quoted&quot;"');
  });

});
