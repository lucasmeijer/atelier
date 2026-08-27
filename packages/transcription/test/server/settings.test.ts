import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultTranscriptionModel, readTranscriptionModel, writeTranscriptionModel } from "../../src/server/models.ts";
import { transcriptionSettingsContribution } from "../../src/server/settings.ts";

let directory: string | undefined;

async function useTemporaryDataDirectory(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "atelier-transcription-settings-"));
  process.env.ATELIER_DATA_DIR = directory;
  return directory;
}

afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("transcription settings", () => {
  test("defaults to multilingual Nemotron and persists another supported model", async () => {
    await useTemporaryDataDirectory();
    expect(await readTranscriptionModel()).toBe(defaultTranscriptionModel);
    await writeTranscriptionModel("parakeet-tdt");
    expect(await readTranscriptionModel()).toBe("parakeet-tdt");
  });

  test("rejects malformed persisted settings", async () => {
    const root = await useTemporaryDataDirectory();
    await writeFile(join(root, "transcription.json"), JSON.stringify({ model: "unknown" }));
    expect(readTranscriptionModel()).rejects.toThrow();
  });

  test("renders and updates the selected server model", async () => {
    await useTemporaryDataDirectory();
    const html = await transcriptionSettingsContribution.render();
    expect(html).toContain('class="settings-select popup-select"');
    expect(html).toContain('<option value="nemotron-3.5" selected>');
    const form = new FormData();
    form.set("model", "nemotron-en");
    const response = await transcriptionSettingsContribution.handleAction!({
      request: new Request("http://atelier/settings/transcription-model", { method: "POST", body: form }),
      url: new URL("http://atelier/settings/transcription-model"),
    });
    expect(response?.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    expect(await readTranscriptionModel()).toBe("nemotron-en");
  });
});
