import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerRuntimeConnectionPath, readDockerRuntimeConnection, registerWorkspaceDocker, retireWorkspaceDocker, type DockerRuntimeConnection } from "./docker-runtime.ts";
import type { WorkspaceDockerPlan } from "./types.ts";

function plan(): WorkspaceDockerPlan {
  return { labels: {}, env: {}, mounts: [], publishes: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
}
test("registration is recorded before dispatch, forwarded to nested workspaces and retired from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docker-runtime-"));
  const calls: string[] = [];
  const connection: DockerRuntimeConnection = { version: 1, adminSocket: join(dir, "admin.sock"), socketDirectory: dir, snapshotterRoot: join(dir, "store"), depth: 0, buildServices: { buildkitSocket: join(dir, "buildkit.sock"), registryAddress: "atelier.tailnet.ts.net:42000" } };
  const metadata = join(dir, "workspace");
  const server = Bun.serve({ unix: connection.adminSocket, async fetch(req) {
    const url = new URL(req.url);
    const saved = JSON.parse(await readFile(join(metadata, "registration.json"), "utf8"));
    expect(saved.clientId).toBe(url.searchParams.get("client"));
    calls.push(url.pathname);
    return new Response(null, { status: 204 });
  } });
  try {
    const p = plan();
    p.env.NO_PROXY = "localhost,127.0.0.1";
    p.env.no_proxy = "localhost,127.0.0.1";
    await registerWorkspaceDocker(p, metadata, connection);
    expect(p.extraArgs).toContain("--dns");
    expect(p.extraArgs).toContain("100.100.100.100");
    expect(p.env.NO_PROXY).toBe("localhost,127.0.0.1,atelier.tailnet.ts.net");
    expect(p.env.no_proxy).toBe(p.env.NO_PROXY);
    expect(p.sharedDocker?.snapshotterSocket).toStartWith(dir + "/");
    expect(p.sharedDocker?.insecureRegistries).toEqual(["atelier.tailnet.ts.net:42000"]);
    expect(p.sharedDocker?.bridgeCIDR).toBe("10.231.0.1/24");
    expect(p.containerFiles[0]!.target).toBe(dockerRuntimeConnectionPath);
    const nested = await readDockerRuntimeConnection(p.containerFiles[0]!.source);
    expect(nested).toEqual({ ...connection, depth: 1 });
    await retireWorkspaceDocker(metadata);
    expect(calls).toEqual(["/register", "/retire"]);
    const first = JSON.parse(await readFile(join(metadata, "registration.json"), "utf8"));
    await registerWorkspaceDocker(plan(), metadata, nested!);
    const second = JSON.parse(await readFile(join(metadata, "registration.json"), "utf8"));
    expect(first.clientId).not.toBe(second.clientId);
  } finally { await server.stop(true); await rm(dir, { recursive: true }); }
});

test("missing descriptor opts out; invalid descriptor and unreachable declared runtime fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docker-runtime-"));
  try {
    const path = join(dir, "connection.json");
    expect(await readDockerRuntimeConnection(path)).toBeUndefined();
    await writeFile(path, "{}");
    await expect(readDockerRuntimeConnection(path)).rejects.toThrow();
    const connection: DockerRuntimeConnection = { version: 1, adminSocket: join(dir, "admin.sock"), socketDirectory: dir, snapshotterRoot: join(dir, "store"), depth: 0 };
    const p = plan();
    await expect(registerWorkspaceDocker(p, join(dir, "ws"), connection)).rejects.toThrow();
    expect(p.sharedDocker).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "ws/registration.json"), "utf8")).clientId).toHaveLength(24);
    await expect(retireWorkspaceDocker(join(dir, "ws"))).rejects.toThrow();
  } finally { await rm(dir, { recursive: true }); }
});

test("failed registration can retire an identity not received by the adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docker-runtime-"));
  const connection: DockerRuntimeConnection = { version: 1, adminSocket: join(dir, "admin.sock"), socketDirectory: dir, snapshotterRoot: join(dir, "store"), depth: 0 };
  const server = Bun.serve({ unix: connection.adminSocket, fetch(req) { return new Response(null, { status: new URL(req.url).pathname === "/register" ? 500 : 204 }); } });
  try {
    await expect(registerWorkspaceDocker(plan(), join(dir, "ws"), connection)).rejects.toThrow("snapshotter register failed");
    await retireWorkspaceDocker(join(dir, "ws"));
  } finally { await server.stop(true); await rm(dir, { recursive: true }); }
});


test("build services must travel through the inherited socket directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docker-runtime-"));
  try {
    const path = join(dir, "connection.json");
    await writeFile(path, JSON.stringify({ version: 1, adminSocket: join(dir, "admin.sock"), socketDirectory: dir, snapshotterRoot: join(dir, "store"), depth: 0, buildServices: { buildkitSocket: "/elsewhere/buildkit.sock", registryAddress: "atelier.tailnet.ts.net:42000" } }));
    await expect(readDockerRuntimeConnection(path)).rejects.toThrow("invalid shared Docker build service sockets");
  } finally { await rm(dir, { recursive: true }); }
});
