import { expect, test } from "bun:test";
import { createDesktopPresenter } from "../src/server/agent-tool.ts";
import type { RunningDesktop } from "../src/server/runtime.ts";

const running: RunningDesktop = { phase: "running", pid: 123, display: ":99", xauthority: "/desktop/Xauthority", cdpUrl: "http://127.0.0.1:9222", width: 800, height: 900 };

test("present desktop waits for readiness and returns CDP details in model-visible text", async () => {
  const calls: string[] = [];
  const presenter = createDesktopPresenter({ startDesktop: async () => { calls.push("start"); return running; }, presentDesktop: async () => { calls.push("present"); } });
  const result = await presenter.execute("call", { kind: "desktop" });
  expect(calls).toEqual(["start", "present"]);
  expect(JSON.parse(result.content[0]!.text)).toEqual({ ...running, workView: { type: "desktop" } });
  expect(result.details).toEqual(JSON.parse(result.content[0]!.text));
});

test("failed startup does not announce or present a ready desktop", async () => {
  const presenter = createDesktopPresenter({ startDesktop: async () => { throw new Error("Xvfb failed"); }, presentDesktop: async () => { throw new Error("must not present"); } });
  await expect(presenter.execute("call", { kind: "desktop" })).rejects.toThrow("Xvfb failed");
});
