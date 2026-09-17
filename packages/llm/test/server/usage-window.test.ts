import { expect, test } from "bun:test";
import type { SubscriptionUsage } from "../../src/server/subscription-usage.ts";
import { usageWindowTiming, selectPacingWindow } from "../../src/server/usage-window.ts";

const window = {
  limitName: "Codex", meteredFeature: null, kind: "primary", usedPercent: 60,
  durationSeconds: 5 * 3600, resetsAt: "2026-09-07T15:00:00.000Z",
} satisfies SubscriptionUsage["windows"][number];

test("infers the start and compares usage to elapsed time in percentage points", () => {
  expect(usageWindowTiming(window, new Date("2026-09-07T12:30:00Z"))).toEqual({
    startsAt: "2026-09-07T10:00:00.000Z", elapsedPercent: 50, state: "active", paceDifferencePoints: 10, paceDifferenceSeconds: 1800,
  });
});

test("distinguishes below and exactly on linear pace", () => {
  expect(usageWindowTiming(window, new Date("2026-09-07T14:00:00Z")).paceDifferencePoints).toBe(-20);
  expect(usageWindowTiming(window, new Date("2026-09-07T13:00:00Z")).paceDifferencePoints).toBe(0);
});

test("clamps time and omits pacing outside the active window", () => {
  expect(usageWindowTiming(window, new Date("2026-09-07T09:00:00Z"))).toMatchObject({ elapsedPercent: 0, state: "not-started", paceDifferencePoints: null });
  expect(usageWindowTiming(window, new Date("2026-09-07T10:00:00Z"))).toMatchObject({ elapsedPercent: 0, state: "active", paceDifferencePoints: 60 });
  expect(usageWindowTiming(window, new Date("2026-09-07T15:00:00Z"))).toMatchObject({ elapsedPercent: 100, state: "reset-due", paceDifferencePoints: null });
  expect(usageWindowTiming(window, new Date("2026-09-08T15:00:00Z"))).toMatchObject({ elapsedPercent: 100, state: "reset-due", paceDifferencePoints: null });
});

test("uses actual durations for weekly and longer windows", () => {
  for (const days of [7, 30]) {
    const reset = new Date(window.resetsAt).getTime();
    const result = usageWindowTiming({ ...window, durationSeconds: days * 86400 }, new Date(reset - days * 86400_000 / 4));
    expect(result.elapsedPercent).toBe(75);
    expect(result.paceDifferencePoints).toBe(-15);
    if (result.state === "unknown") throw new Error("Expected known reset timing");
    expect(new Date(result.startsAt).getTime()).toBe(reset - days * 86400_000);
  }
});

test("prioritizes the greatest lead over the highest raw usage", () => {
  const highUsage = pacedWindow("Weekly", 95, 99);
  const ahead = pacedWindow("Five-hour", 60, 30);
  expect(selectPacingWindow([highUsage, ahead])).toBe(ahead);
});

test("unused feature buckets cannot hide a used allowance that is behind pace", () => {
  const used = pacedWindow("Codex", 60, 90);
  const unused = pacedWindow("Spark", 0, 0);
  expect(selectPacingWindow([unused, used])).toBe(used);
  expect(selectPacingWindow([unused])).toBe(unused);
});

test("ties prefer the more consumed window", () => {
  const lower = pacedWindow("Lower", 40, 20);
  const higher = pacedWindow("Higher", 70, 50);
  expect(selectPacingWindow([lower, higher])).toBe(higher);
});

test("does not display pacing for expired or not-started windows", () => {
  const expired = { reported: window, timing: usageWindowTiming(window, new Date(window.resetsAt)) };
  const future = { reported: window, timing: usageWindowTiming(window, new Date("2026-09-07T09:00:00Z")) };
  expect(selectPacingWindow([expired, future])).toBeUndefined();
  expect(selectPacingWindow([])).toBeUndefined();
  const current = pacedWindow("Current", 50, 25);
  expect(selectPacingWindow([expired, future, current])).toBe(current);
});

function pacedWindow(name: string, usage: number, time: number) {
  const reported: SubscriptionUsage["windows"][number] = { ...window, limitName: name, usedPercent: usage };
  const at = new Date(new Date(window.resetsAt).getTime() - window.durationSeconds * 1000 * (1 - time / 100));
  return { reported, timing: usageWindowTiming(reported, at) };
}

test("an unused main allowance takes precedence over feature windows that have not been used", () => {
  const main = pacedWindow("Codex", 0, 25);
  const feature = pacedWindow("Spark", 0, 0);
  feature.reported.meteredFeature = "codex_spark";
  expect(selectPacingWindow([feature, main])).toBe(main);
});

test("expresses ahead, behind and on pace as distance along the window schedule", () => {
  expect(usageWindowTiming(window, new Date("2026-09-07T12:30:00Z")).paceDifferenceSeconds).toBe(1800);
  expect(usageWindowTiming(window, new Date("2026-09-07T14:00:00Z")).paceDifferenceSeconds).toBe(-3600);
  expect(usageWindowTiming(window, new Date("2026-09-07T13:00:00Z")).paceDifferenceSeconds).toBe(0);
});

test("the same percentage gap represents different durations for different allowances", () => {
  const reset = new Date(window.resetsAt).getTime();
  for (const durationSeconds of [5 * 3600, 7 * 86400, 30 * 86400]) {
    const timing = usageWindowTiming({ ...window, usedPercent: 52, durationSeconds }, new Date(reset - durationSeconds * 1000 / 2));
    expect(timing.paceDifferenceSeconds).toBeCloseTo(durationSeconds * 0.02);
  }
});

test("schedule distance is unavailable before a window starts and after it resets", () => {
  for (const at of ["2026-09-07T09:00:00Z", window.resetsAt, "2026-09-08T15:00:00Z"]) {
    expect(usageWindowTiming(window, new Date(at)).paceDifferenceSeconds).toBeNull();
  }
});

test("missing reset timestamps preserve unknown timing and never participate in pacing", () => {
  for (const usedPercent of [0, 42]) {
    const reported = { ...window, usedPercent, resetsAt: null };
    const timing = usageWindowTiming(reported, new Date("2026-09-07T12:30:00Z"));
    expect(timing).toEqual({ state: "unknown", startsAt: null, elapsedPercent: null, paceDifferencePoints: null, paceDifferenceSeconds: null });
    const unknown = { reported, timing };
    expect(selectPacingWindow([unknown])).toBeUndefined();
    const active = pacedWindow("Active", 20, 10);
    expect(selectPacingWindow([unknown, active])).toBe(active);
  }
});
