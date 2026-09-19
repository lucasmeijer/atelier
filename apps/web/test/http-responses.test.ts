import { expect, test } from "bun:test";
import { AtelierCoreError } from "@atelier/core";
import { problemJsonResponse } from "../src/server/http-responses.ts";

test("invalid terminal cwd returns a client validation response", async () => {
  const message = "terminal cwd must be under /work: /tmp/qa-run";
  const response = problemJsonResponse(new AtelierCoreError("terminal_invalid_cwd", message));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "terminal_invalid_cwd", message } });
});

test("terminal creation failures remain server errors", () => {
  expect(problemJsonResponse(new AtelierCoreError("terminal_create_failed", "creation failed")).status).toBe(500);
});
