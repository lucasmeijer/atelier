import { describe, expect, test } from "bun:test";
import { turboStream } from "../src/index.ts";

describe("Turbo Stream HTML", () => {
  test("renders morph updates", () => {
    expect(turboStream("update", "update_status", "<p>43%</p>", { method: "morph" })).toBe(
      '<turbo-stream action="update" target="update_status" method="morph"><template><p>43%</p></template></turbo-stream>',
    );
  });
});
