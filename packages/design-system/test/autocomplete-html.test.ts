import { describe, expect, test } from "bun:test";
import { autocompleteHtml } from "../src/autocomplete/autocomplete-html.ts";

describe("autocompleteHtml", () => {
  test("renders an accessible listbox of trusted options", () => {
    const html = autocompleteHtml({
      kind: "results",
      label: "Files <and folders>",
      contentHtml: '<button role="option">README.md</button>',
    });

    expect(html).toContain('class="floating-surface autocomplete action-list"');
    expect(html).toContain('role="listbox" aria-label="Files &lt;and folders&gt;"');
    expect(html).toContain('<button role="option">README.md</button>');
  });

  test("renders escaped empty and trusted loading messages", () => {
    expect(autocompleteHtml({ kind: "message", content: { kind: "text", text: "No <results>" } })).toContain("No &lt;results&gt;");
    expect(autocompleteHtml({ kind: "message", role: "status", content: { kind: "html", html: "<i></i>Loading…" } })).toContain('role="status"><i></i>Loading…');
  });
});
