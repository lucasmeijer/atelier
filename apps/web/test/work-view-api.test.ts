import { describe, expect, test } from "bun:test";
import { parseCloseWorkViewRequest, parseReorderWorkViewRequest } from "../src/server/work-view-api.ts";

describe("Work view API requests", () => {
  test("parses a reorder request", () => {
    expect(parseReorderWorkViewRequest({ key: "file:README.md", index: 0 })).toEqual({ key: "file:README.md", index: 0 });
  });

  test("rejects indices that cannot represent a position", () => {
    expect(() => parseReorderWorkViewRequest({ key: "file:README.md", index: -1 })).toThrow("non-negative integer index");
    expect(() => parseReorderWorkViewRequest({ key: "file:README.md", index: 1.5 })).toThrow("non-negative integer index");
  });

  test("parses an open Work view reference without constraining feature-owned fields", () => {
    expect(parseCloseWorkViewRequest({ reference: { type: "file", path: "README.md" } })).toEqual({
      reference: { type: "file", path: "README.md" },
    });
  });

  test("rejects a reference without its dispatch type", () => {
    expect(() => parseCloseWorkViewRequest({ reference: { path: "README.md" } })).toThrow("reference with a type is required");
  });
});
