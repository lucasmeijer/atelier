import { expect, test } from "bun:test";
import { installationStatus } from "./installation-status.ts";

const input = {
  activity: { description: "Preparing Atelier", percent: 40 },
  stopping: false, busy: false, appResponding: true,
  hostname: "atelier.example.ts.net", appliedRoute: "atelier.example.ts.net:3000",
  connectionState: "Running", logs: ["App exited with code 1"],
};

test("System owns destinations and only releases the app URL after health and routing", () => {
  const status = installationStatus(input);
  expect(status.state).toBe("ready");
  expect(status.appUrl).toBe("https://atelier.example.ts.net");
  expect(status.supervisorUrl).toBe("https://atelier.example.ts.net:8443");
  for (const change of [{ appResponding: false }, { busy: true }, { appliedRoute: "atelier.example.ts.net:3001" }, { hostname: undefined }]) {
    const pending = installationStatus({ ...input, ...change });
    expect(pending.state).toBe("starting");
    expect(pending.appUrl).toBeUndefined();
  }
});

test("failure offers routed diagnostics, not the app", () => {
  const status = installationStatus({ ...input, failure: "Health timed out" });
  expect(status.state).toBe("failed");
  expect(status.activity.description).toBe("Health timed out");
  expect(status.appUrl).toBeUndefined();
  expect(status.supervisorUrl).toBeDefined();
  expect(status.diagnostics?.lines).toEqual([]);
});

test("failure without routing provides recent System logs directly", () => {
  const status = installationStatus({ ...input, failure: "Health timed out", appliedRoute: "" });
  expect(status.supervisorUrl).toBeUndefined();
  expect(status.diagnostics?.lines).toEqual(input.logs);
});

test("System translates sign-in and machine approval into user actions", () => {
  const disconnected = { ...input, hostname: undefined, appliedRoute: "" };
  const login = installationStatus({ ...disconnected, connectionState: "NeedsLogin", authUrl: "https://login.tailscale.com/a/example" });
  expect(login.state).toBe("starting");
  expect(login.action?.url).toBe("https://login.tailscale.com/a/example");
  expect(login.appUrl).toBeUndefined();
  const approval = installationStatus({ ...disconnected, connectionState: "NeedsMachineAuth" });
  expect(approval.action?.url).toBe("https://login.tailscale.com/admin/machines");
  expect(installationStatus(input).action).toBeUndefined();
});

test("stopping never advertises readiness and unknown-duration activity has no percent", () => {
  expect(installationStatus({ ...input, stopping: true }).state).toBe("failed");
  const starting = installationStatus({ ...input, appResponding: false, activity: { description: "Starting Atelier" } });
  expect(starting.activity.percent).toBeUndefined();
});

test("local install becomes ready without Tailscale and keeps diagnostics reachable", () => {
  const status = installationStatus({ activity: { description: "Starting" }, stopping: false, busy: false, appResponding: true, appliedRoute: "", connectionState: "NeedsLogin", authUrl: "https://login.tailscale.com/test", logs: [], localMode: true, localOrigin: "http://atelier.localhost:55001" });
  expect(status.state).toBe("ready");
  expect(status.appUrl).toBe("http://atelier.localhost:55001");
  expect(status.supervisorUrl).toBe("http://system.atelier.localhost:55001");
  expect(status.action).toBeUndefined();
});

test("failures suppress unrelated sign-in actions", () => {
  const status = installationStatus({ ...input, failure: "Host requirement missing", connectionState: "NeedsLogin", authUrl: "https://login.example" });
  expect(status.state).toBe("failed");
  expect(status.activity.description).toBe("Host requirement missing");
  expect(status.action).toBeUndefined();
  expect(status.appUrl).toBeUndefined();
});
