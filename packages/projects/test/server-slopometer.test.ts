import { describe, expect, test } from "bun:test";
import { renderSlopometer } from "../src/server/index.ts";

describe("project slopometer rendering", () => {
  test("uses full accent color at 200 changed lines", () => {
    expect(renderSlopometer(200, 0)).toContain("--project-slopometer-stat-muted: 0%; --project-slopometer-stat-accent: 100%");
  });

  test("keeps values below 200 partially mixed", () => {
    expect(renderSlopometer(199, 0)).toContain("--project-slopometer-stat-muted: 0.5%; --project-slopometer-stat-accent: 99.5%");
  });
});
