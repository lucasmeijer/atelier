import { describe, expect, test } from "bun:test";
import { toggleHtml } from "../src/toggle/toggle-html.ts";

describe("toggleHtml", () => {
  test("renders an interactive default container and escapes text", () => {
    const html = toggleHtml({
      variant: "text-subtle",
      label: "Result <view>",
      name: "result-view",
      value: "output",
      options: [
        { label: "Output & display", value: "output" },
        { label: "Model", value: "model", disabled: true },
      ],
    });

    expect(html).toContain('class="text-toggle subtle" role="group" aria-label="Result &lt;view&gt;" data-controller="toggle"');
    expect(html).toContain('name="result-view" value="output" aria-pressed="true">Output &amp; display</button>');
    expect(html).toContain('name="result-view" value="model" aria-pressed="false" disabled>Model</button>');
  });

  test("supports a concise submit form and trusted labels", () => {
    const html = toggleHtml({
      variant: "button",
      label: "Feature",
      name: "enabled",
      value: "true",
      form: { id: "feature", action: "/feature?a=1&b=2" },
      options: [
        { html: "<strong>Off</strong>", value: "false" },
        { html: "<strong>On</strong>", value: "true", data: { choice: "on&ready" } },
      ],
    });

    expect(html).toContain('<form class="button-toggle" role="group" aria-label="Feature" data-controller="toggle" id="feature" method="post" action="/feature?a=1&amp;b=2" data-turbo="true">');
    expect(html).toContain('type="submit" name="enabled" value="true" aria-pressed="true" data-choice="on&amp;ready"><strong>On</strong></button>');
  });

  test("supports typed integration data on a non-default element", () => {
    const html = toggleHtml({
      variant: "text",
      label: "Preview",
      name: "preview",
      value: "raw",
      element: {
        tag: "span",
        id: "preview-toggle",
        dataAction: "change->preview#select",
        data: { "preview-target": "toggle", busy: false },
      },
      options: [
        { label: "Raw", value: "raw" },
        { label: "Rendered", value: "rendered" },
      ],
    });

    expect(html).toContain('data-controller="toggle" id="preview-toggle" data-action="change-&gt;preview#select" data-preview-target="toggle" data-busy="false"');
  });

  test("rejects configurations without exactly one selected option", () => {
    expect(() => toggleHtml({
      variant: "button",
      label: "Duplicate",
      name: "duplicate",
      value: "same",
      options: [
        { label: "One", value: "same" },
        { label: "Two", value: "same" },
      ],
    })).toThrow("Toggle option value must be unique: same");

    expect(() => toggleHtml({
      variant: "button",
      label: "Missing",
      name: "missing",
      value: "other",
      options: [
        { label: "One", value: "one" },
        { label: "Two", value: "two" },
      ],
    })).toThrow("Toggle value has no matching option: other");
  });
});
