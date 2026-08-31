import { describe, expect, test } from "bun:test";
import { transientFeedbackHtml } from "../src/transient-feedback/transient-feedback-html.ts";

describe("transientFeedbackHtml", () => {
  test("renders arbitrary flow content in an immediately announced result", () => {
    const html = transientFeedbackHtml({
      element: { tag: "div", className: "update-check" },
      initialContent: { kind: "html", html: "<form>Check</form>" },
      feedbackContent: { kind: "text", text: "You're <current>" },
      state: "feedback",
    });

    expect(html).toContain('data-transient-feedback-state-value="feedback"');
    expect(html).toContain('data-transient-feedback-content="initial" hidden><form>Check</form>');
    expect(html).toContain('data-transient-feedback-content="feedback" role="status">You&#39;re &lt;current&gt;');
  });
});
