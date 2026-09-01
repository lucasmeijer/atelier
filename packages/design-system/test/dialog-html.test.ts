import { describe, expect, test } from "bun:test";
import { dialogHtml } from "../src/dialog/dialog-html.ts";

describe("dialogHtml", () => {
  test("renders a titled native dialog with canonical panel regions and close control", () => {
    const html = dialogHtml({
      element: { id: "connect_provider", className: "provider-dialog", attributesHtml: 'aria-label="Connect provider" data-dialog-auto-show' },
      iconHtml: "<svg></svg>",
      titleCaption: "Connect provider",
      bodyHtml: "<p>Enter an API key.</p>",
      footerHtml: "<button>Connect</button>",
      closeLabel: "Close provider connection",
    });

    expect(html).toContain('<h2 class="panel__title dialog__title"><svg></svg><span>Connect provider</span></h2>');
    expect(html).toContain('class="dialog__close button secondary icon-only" value="close" title="Close provider connection" aria-label="Close provider connection"');
    expect(html).toContain('<div class="panel__body"><p>Enter an API key.</p></div><footer class="panel__footer"><button>Connect</button></footer>');
  });

  test("uses the default close label and omits optional identity and footer markup", () => {
    const html = dialogHtml({ element: {}, iconHtml: "<svg></svg>", titleCaption: "Command", bodyHtml: "Results" });

    expect(html).not.toContain(" id=");
    expect(html).not.toContain("panel__footer");
    expect(html).toContain('aria-label="Close dialog"');
  });

  test("escapes caller-owned identity, class names, and close label", () => {
    const html = dialogHtml({
      element: { id: 'unsafe" data-id="injected', className: 'wide" data-class="injected' },
      iconHtml: "<svg></svg>",
      titleCaption: '<Header data-title="injected">',
      bodyHtml: "Body",
      closeLabel: 'Close" data-close="injected',
    });

    expect(html).toContain('id="unsafe&quot; data-id=&quot;injected"');
    expect(html).toContain('class="dialog dialog--panel wide&quot; data-class=&quot;injected"');
    expect(html).toContain("<span>&lt;Header data-title=&quot;injected&quot;&gt;</span>");
    expect(html).toContain('aria-label="Close&quot; data-close=&quot;injected"');
  });
});
