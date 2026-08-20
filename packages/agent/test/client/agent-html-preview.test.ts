import { describe, expect, test } from "bun:test";
import { fitHtmlPreview } from "../../src/client/agent-controllers.ts";

describe("agent HTML preview fitting", () => {
  test("fits content from the fixed preview baseline", () => {
    const frame = { style: { height: "900px" } };
    const measuredAt: string[] = [];
    const doc = {
      documentElement: { get scrollHeight() { measuredAt.push(frame.style.height); return 2_400; } },
      body: { get scrollHeight() { measuredAt.push(frame.style.height); return 2_200; } },
    };

    fitHtmlPreview(frame, doc);

    expect(measuredAt).toEqual(["420px", "420px"]);
    expect(frame.style.height).toBe("2400px");
  });

  test("does not feed viewport-dependent growth back into the next fit", () => {
    const frame = { style: { height: "420px" } };
    const viewportDependentHeight = () => Number.parseInt(frame.style.height) + 100;
    const doc = {
      documentElement: { get scrollHeight() { return viewportDependentHeight(); } },
      body: { get scrollHeight() { return viewportDependentHeight(); } },
    };

    fitHtmlPreview(frame, doc);
    fitHtmlPreview(frame, doc);

    expect(frame.style.height).toBe("520px");
  });
});
