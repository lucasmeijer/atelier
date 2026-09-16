import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTranscriptionRuntime } from "../../src/server/runtime.ts";

let directory: string;
let archive: Uint8Array<ArrayBuffer>;
let checksum: string;
let requests: string[];
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let whichSpy: ReturnType<typeof spyOn<typeof Bun, "which">>;
const architecture = process.arch === "x64" ? "x86_64" : "aarch64";
const archiveName = `nemo-speech-0.1.0-linux-${architecture}-cpu.tar.gz`;
const releaseUrl = "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0";

function mockFetch(handler: (input: RequestInfo | URL) => Promise<Response>): void {
  fetchSpy.mockImplementation(Object.assign(handler, { preconnect: fetch.preconnect }));
}

beforeEach(async () => {
  whichSpy = spyOn(Bun, "which").mockReturnValue(null);
  directory = await mkdtemp(join(tmpdir(), "transcription-runtime-test-"));
  const bin = join(directory, "fixture", "release", "bin");
  await mkdir(bin, { recursive: true });
  await Bun.write(join(bin, "nemo-speech"), "#!/bin/sh\necho fixture-runtime\n");
  await chmod(join(bin, "nemo-speech"), 0o755);
  const archivePath = join(directory, archiveName);
  const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", join(directory, "fixture"), "release"]);
  expect(await tar.exited).toBe(0);
  archive = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
  checksum = createHash("sha256").update(archive).digest("hex");
  requests = [];
  fetchSpy = spyOn(globalThis, "fetch");
  mockFetch(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === `${releaseUrl}/${archiveName}.sha256`) return new Response(`${checksum}  ${archiveName}\n`);
    if (url === `${releaseUrl}/${archiveName}`) return new Response(archive);
    throw new Error(`Unexpected download: ${url}`);
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  whichSpy.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

test("downloads the pinned release once for concurrent callers and reuses it offline", async () => {
  const cache = join(directory, "cache");
  const [first, second] = await Promise.all([ensureTranscriptionRuntime(cache), ensureTranscriptionRuntime(cache)]);
  expect(first).toBe(second);
  expect(first).toBe(join(cache, "runtimes", archiveName.replace(".tar.gz", ""), "bin", "nemo-speech"));
  const child = Bun.spawn([first], { stdout: "pipe" });
  expect(await new Response(child.stdout).text()).toBe("fixture-runtime\n");
  expect(await child.exited).toBe(0);
  expect(requests).toEqual([`${releaseUrl}/${archiveName}.sha256`, `${releaseUrl}/${archiveName}`]);
  mockFetch(async () => { throw new Error("offline"); });
  expect(await ensureTranscriptionRuntime(cache)).toBe(first);
  expect(await readdir(join(cache, "runtimes"))).toEqual([archiveName.replace(".tar.gz", "")]);
});

test("rejects a checksum mismatch without publishing a runtime and allows retry", async () => {
  const cache = join(directory, "cache");
  const correct = checksum;
  checksum = "0".repeat(64);
  await expect(ensureTranscriptionRuntime(cache)).rejects.toThrow("checksum mismatch");
  expect(await readdir(join(cache, "runtimes"))).toEqual([]);
  checksum = correct;
  expect(await Bun.file(await ensureTranscriptionRuntime(cache)).exists()).toBe(true);
});

test("rejects a malformed checksum before downloading the archive", async () => {
  checksum = "not-a-sha256";
  await expect(ensureTranscriptionRuntime(join(directory, "cache"))).rejects.toThrow("Invalid NeMo Speech release checksum file");
  expect(requests).toHaveLength(1);
});

test("reports HTTP failures and removes partial installation files", async () => {
  mockFetch(async () => new Response("unavailable", { status: 503 }));
  const cache = join(directory, "cache");
  await expect(ensureTranscriptionRuntime(cache)).rejects.toThrow("NeMo Speech download failed: 503");
  expect(await readdir(join(cache, "runtimes"))).toEqual([]);
});

test("does not publish an archive that cannot be extracted", async () => {
  archive = new TextEncoder().encode("invalid archive");
  checksum = createHash("sha256").update(archive).digest("hex");
  const cache = join(directory, "cache");
  await expect(ensureTranscriptionRuntime(cache)).rejects.toThrow("NeMo Speech extraction failed");
  expect(await readdir(join(cache, "runtimes"))).toEqual([]);
});


test("uses the bundled runtime without downloading or creating a cache", async () => {
  const bundled = join(directory, "fixture", "release", "bin", "nemo-speech");
  whichSpy.mockReturnValue(bundled);
  mockFetch(async () => { throw new Error("Bundled runtime must not require network access"); });
  const before = await readdir(directory);
  expect(await ensureTranscriptionRuntime(join(directory, "cache"))).toBe(bundled);
  expect(whichSpy).toHaveBeenCalledWith("nemo-speech");
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual(before);
});
