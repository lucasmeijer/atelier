import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_HUMAN_TIMINGS,
	buildFfmpegArgs,
	normalizeTimings,
	recordAtelierDemo,
	recordingPaths,
} from "../demo/recording/atelier-recording.ts";

const temporaryDirectories: string[] = [];

afterAll(async () => {
	await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Atelier recording helpers", () => {
	test("normalizes partial timing overrides and rejects invalid values", () => {
		expect(normalizeTimings({ keyDelayMs: 12, afterActionMs: 0 })).toEqual({
			...DEFAULT_HUMAN_TIMINGS,
			keyDelayMs: 12,
			afterActionMs: 0,
		});
		expect(() => normalizeTimings({ beforeClickMs: -1 })).toThrow("finite non-negative");
		expect(() => normalizeTimings({ keyDelayMs: Number.NaN })).toThrow("finite non-negative");
	});

	test("creates predictable diagnostic and output paths", () => {
		expect(recordingPaths("workspace-demo", "/tmp/recordings")).toEqual({
			artifactRoot: "/tmp/recordings",
			outputPath: "/tmp/recordings/workspace-demo.mp4",
			rawVideoPath: "/tmp/recordings/workspace-demo.raw.webm",
			failureScreenshotPath: "/tmp/recordings/workspace-demo.failure.png",
		});
		expect(() => recordingPaths("../escape", "/tmp/recordings")).toThrow("recording name");
		expect(() => recordingPaths("demo", "relative")).toThrow("must be absolute");
	});

	test("constructs browser-safe H.264 FFmpeg arguments", () => {
		expect(buildFfmpegArgs("/tmp/raw.webm", "/tmp/demo.mp4", 25)).toEqual([
			"-y",
			"-nostdin",
			"-i",
			"/tmp/raw.webm",
			"-an",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-r",
			"25",
			"-movflags",
			"+faststart",
			"/tmp/demo.mp4",
		]);
		expect(() => buildFfmpegArgs("raw.webm", "/tmp/demo.mp4")).toThrow("absolute .webm");
		expect(() => buildFfmpegArgs("/tmp/raw.webm", "/tmp/demo.webm")).toThrow("absolute .mp4");
	});
});

test("a failed scenario preserves diagnostics and rethrows the original failure", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "atelier-recording-failure-"));
	temporaryDirectories.push(artifactRoot);
	const originalFailure = new Error("intentional scenario failure");

	let caught: unknown;
	try {
		await recordAtelierDemo(
			{
				name: "failure-fixture",
				artifactRoot,
				viewport: { width: 480, height: 320 },
				timings: {
					beforeClickMs: 0,
					afterClickMs: 0,
					beforeTypeMs: 0,
					keyDelayMs: 0,
					afterTypeMs: 0,
					afterActionMs: 0,
				},
			},
			async ({ page }) => {
				await page.setContent("<main><h1>Failure fixture</h1><p>Diagnostic frame</p></main>");
				throw originalFailure;
			},
		);
	} catch (error) {
		caught = error;
	}

	expect(caught).toBe(originalFailure);
	const paths = recordingPaths("failure-fixture", artifactRoot);
	expect((await stat(paths.rawVideoPath)).size).toBeGreaterThan(0);
	expect((await stat(paths.failureScreenshotPath)).size).toBeGreaterThan(0);
	expect((await readFile(paths.failureScreenshotPath)).subarray(1, 4).toString()).toBe("PNG");
}, 20_000);
