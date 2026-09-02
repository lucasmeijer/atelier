import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionImageEndpoint } from "../../src/server/session-images.ts";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function makeSession(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "atelier-session-images-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, `${JSON.stringify({
    type: "message",
    id: "image-entry",
    message: {
      role: "toolResult",
      content: [
        { type: "text", text: "an image" },
        { type: "image", mimeType: "image/png", data: Buffer.from("png bytes").toString("base64") },
      ],
    },
  })}\n`);
  return path;
}

describe("pi session images", () => {
  test("serves an image directly from its transcript session", async () => {
    const response = await sessionImageEndpoint(await makeSession(), "image-entry", 1);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe("png bytes");
  });

  test("rejects non-image parts", async () => {
    const response = await sessionImageEndpoint(await makeSession(), "image-entry", 0);
    expect(response.status).toBe(404);
  });

  test("rejects image parts with invalid persisted data", async () => {
    const path = await makeSession();
    await writeFile(path, `${JSON.stringify({
      id: "image-entry",
      message: { content: [{ type: "image", mimeType: "image/png", data: 42 }] },
    })}\n`);

    const response = await sessionImageEndpoint(path, "image-entry", 0);
    expect(response.status).toBe(404);
  });
});
