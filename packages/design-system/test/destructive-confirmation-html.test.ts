import { describe, expect, test } from "bun:test";
import { destructiveConfirmationHtml } from "../src/destructive-confirmation/destructive-confirmation-html.ts";

describe("destructiveConfirmationHtml", () => {
  test("renders an inert decision with escaped caller captions", () => {
    const html = destructiveConfirmationHtml({
      buttonHtml: '<button class="button danger icon-only" type="button">×</button>',
      confirmCaption: "Yes, close <now>",
      cancelCaption: "Oops & stay",
    });

    expect(html).toContain('<div class="destructive-confirmation__trigger"><button class="button danger icon-only" type="button">×</button></div>');
    expect(html).toContain('<div class="destructive-confirmation__decision" inert>');
    expect(html).toContain('<button class="button danger destructive-confirmation__action" type="submit">Yes, close &lt;now&gt;</button>');
    expect(html).toContain('<button class="button secondary destructive-confirmation__cancel" type="button">Oops &amp; stay</button>');
  });

  test("supports a distinct confirmation form action", () => {
    const html = destructiveConfirmationHtml({
      buttonHtml: '<button type="button">Remove</button>',
      confirmCaption: "Remove",
      cancelCaption: "Cancel",
      confirmFormAction: '/items/one/delete?returnTo=a&b="quoted"',
    });

    expect(html).toContain('formaction="/items/one/delete?returnTo=a&amp;b=&quot;quoted&quot;"');
  });

  test("supports primary consequential actions", () => {
    const html = destructiveConfirmationHtml({
      buttonHtml: '<button class="button primary" type="button">Restart</button>',
      confirmCaption: "Restart",
      cancelCaption: "Cancel",
      variant: "primary",
    });

    expect(html).toContain('class="button primary destructive-confirmation__action"');
  });
});
