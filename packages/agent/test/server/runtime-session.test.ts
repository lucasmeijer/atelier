import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { discardBootstrapOnlySession } from "../../src/server/runtime.ts";

let dir: string | undefined;

async function sessionFile(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "atelier-runtime-session-test-"));
  return join(dir, "session.jsonl");
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("runtime session persistence", () => {
  test("discards sessions that only contain bootstrap model state", async () => {
    const path = await sessionFile();
    await writeFile(path, [
      JSON.stringify({ type: "model_change", id: "a", parentId: null, provider: "openai", modelId: "gpt" }),
      JSON.stringify({ type: "thinking_level_change", id: "b", parentId: "a", thinkingLevel: "off" }),
      "",
    ].join("\n"));

    await discardBootstrapOnlySession(path);

    expect(await readFile(path, "utf8")).toBe("");
  });

  test("keeps sessions that contain conversation entries", async () => {
    const path = await sessionFile();
    const content = [
      JSON.stringify({ type: "model_change", id: "a", parentId: null, provider: "openai", modelId: "gpt" }),
      JSON.stringify({ type: "message", id: "b", parentId: "a", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      "",
    ].join("\n");
    await writeFile(path, content);

    await discardBootstrapOnlySession(path);

    expect(await readFile(path, "utf8")).toBe(content);
  });
});
