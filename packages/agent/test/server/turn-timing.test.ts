import { expect, test } from "bun:test";
import { TurnTiming } from "../../src/server/turn-timing.ts";
import { buildTranscript } from "../../src/server/transcript.ts";
import { recordsFromSessionEntries } from "../../src/server/session-records.ts";

test("parallel tools count once, inference includes full wait and all reported output", () => {
  const timing = new TurnTiming(0);
  timing.inferenceStart(0);
  timing.inferenceEnd(2000, 100);
  timing.toolStart("a", 2000);
  timing.toolStart("b", 3000);
  timing.toolEnd("a", 5000);
  timing.toolEnd("b", 6000);
  timing.inferenceStart(6000);
  timing.inferenceEnd(8000, 300);
  expect(timing.snapshot(8000)).toEqual({ elapsedMs: 8000, inferenceMs: 4000, toolMs: 4000, outputTokens: 400, usageComplete: true });
});

test("unfinished intervals and missing usage do not fabricate a rate", () => {
  const timing = new TurnTiming(0);
  timing.inferenceStart(100);
  expect(timing.snapshot(500)).toMatchObject({ inferenceMs: 400, usageComplete: false });
  timing.inferenceEnd(1000, undefined);
  timing.toolStart("a", 1000);
  expect(timing.snapshot(2000)).toMatchObject({ inferenceMs: 900, toolMs: 1000, usageComplete: false });
});

test("timing survives session loading and belongs to the completed user turn", () => {
  const timing = { elapsedMs: 8000, inferenceMs: 4000, toolMs: 4000, outputTokens: 400, usageComplete: true };
  const transcript = buildTranscript(recordsFromSessionEntries([
    { type: "message", id: "u", timestamp: new Date(0).toISOString(), message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "message", id: "a", timestamp: new Date(8000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
    { type: "custom", customType: "atelier.turn-timing", timestamp: new Date(8000).toISOString(), data: timing },
  ]));
  expect(transcript.find(item => item.type === "working")).toMatchObject({ timing });
});

test("separate tool batches exclude time between batches", () => {
  const timing = new TurnTiming(0);
  timing.toolStart("a", 100);
  timing.toolEnd("a", 300);
  timing.toolStart("b", 800);
  timing.toolEnd("b", 1000);
  expect(timing.snapshot(1200).toolMs).toBe(400);
});

test("invalid provider usage makes the rate unavailable", () => {
  for (const output of [undefined, NaN, Infinity, -1]) {
    const timing = new TurnTiming(0);
    timing.inferenceStart(0);
    timing.inferenceEnd(1000, output);
    expect(timing.snapshot(1000)).toMatchObject({ outputTokens: 0, usageComplete: false });
  }
});


test("addressed delayed summaries cannot attach to a newer steering turn", () => {
  const timing = { elapsedMs: 200, inferenceMs: 150, toolMs: 50, outputTokens: 40, usageComplete: true };
  const transcript = buildTranscript(recordsFromSessionEntries([
    { type: "message", id: "old", timestamp: new Date(100).toISOString(), message: { role: "user", content: "go" } },
    { type: "message", id: "new", timestamp: new Date(300).toISOString(), message: { role: "user", content: "steer" } },
    { type: "custom", customType: "atelier.turn-timing", timestamp: new Date(350).toISOString(), data: { ...timing, turnEntryId: "old", outcome: "completed" } },
  ]));
  expect(transcript.find(item => item.key === "old:working")).toMatchObject({ timing, completedAt: 300 });
  expect(transcript.find(item => item.key === "new:working")).not.toHaveProperty("timing");
});

test("timing closes a turn even without an assistant answer and restores terminal outcome", () => {
  const timing = { elapsedMs: 700, inferenceMs: 700, toolMs: 0, outputTokens: 0, usageComplete: false };
  for (const outcome of ["completed", "stopped"] as const) {
    const transcript = buildTranscript(recordsFromSessionEntries([
      { type: "message", id: "u", timestamp: new Date(100).toISOString(), message: { role: "user", content: "go" } },
      { type: "custom", customType: "atelier.turn-timing", timestamp: new Date(900).toISOString(), data: { ...timing, turnEntryId: "u", outcome } },
    ]));
    expect(transcript[1]).toMatchObject({ key: "u:working", timing, [outcome === "completed" ? "completedAt" : "stoppedAt"]: 800 });
  }
});

test("an addressed summary from another branch never falls back to the latest turn", () => {
  const timing = { elapsedMs: 1, inferenceMs: 1, toolMs: 0, outputTokens: 1, usageComplete: true };
  const transcript = buildTranscript([
    { kind: "user", id: "here", text: "go", images: [], timestamp: 0 },
    { kind: "timing", turnEntryId: "other-branch", outcome: "completed", timing, timestamp: 1 },
  ]);
  expect(transcript[1]).not.toHaveProperty("timing");
});
