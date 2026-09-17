import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as models from "../../src/server/pi-config-models.ts";
import { handleModelSettingsRequest } from "../../src/server/settings.ts";

let directory: string | undefined;
let previous: string | undefined;
afterEach(async () => {
  if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previous;
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a new provider login cancels its abandoned pending attempt instead of queuing behind it", async () => {
  previous = process.env.ATELIER_DATA_DIR;
  directory = await mkdtemp(join(tmpdir(), "atelier-oauth-lifecycle-"));
  process.env.ATELIER_DATA_DIR = directory;
  const signals: AbortSignal[] = [];
  const rejectLogins: Array<(error: Error) => void> = [];
  const login = spyOn(models, "loginPiOAuthProvider").mockImplementation(async (_provider, interaction) => {
    signals.push(interaction.signal!);
    interaction.notify?.({ type: "auth_url", url: "https://example.com/sign-in" });
    return new Promise<void>((_resolve, reject) => {
      rejectLogins.push(reject);
      interaction.signal!.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
  });
  try {
    const url = new URL("http://localhost/settings/models/step?provider=openai-codex");
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await handleModelSettingsRequest(new Request(url), url, async () => "", async () => new Response());
      expect(response?.status).toBe(200);
    }
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  } finally {
    for (const reject of rejectLogins) reject(new Error("Test finished"));
    await Bun.sleep(0);
    login.mockRestore();
  }
});
