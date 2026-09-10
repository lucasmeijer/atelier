import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TailscaleServeConfig } from "../proxy-ingress/src/ingress/tailscale-serve.ts";
import { ensureRegistryForward, removeRegistryForward } from "./registry-runtime.ts";

const web = { TCP: { "443": { HTTPS: true } }, Web: { "atelier.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:80/" } } } } };

test("registry forwarding is idempotent, private to the tailnet, and preserves HTTPS routes", () => {
  const config: TailscaleServeConfig = structuredClone(web);
  expect(ensureRegistryForward(config, 42000)).toBe(true);
  expect(config.TCP).toEqual({ "443": { HTTPS: true }, "42000": { TCPForward: "127.0.0.1:42000" } });
  expect(ensureRegistryForward(config, 42000)).toBe(false);
  expect(removeRegistryForward(config, 42000)).toBe(true);
  expect(config).toEqual(web);
  expect(removeRegistryForward(config, 42000)).toBe(false);
});

test("registry publication refuses collisions and Funnel exposure, and cleanup only removes its own route", () => {
  const entries: TailscaleServeConfig[] = [{ HTTPS: true }, { TCPForward: "127.0.0.1:1234" }, { TCPForward: "127.0.0.1:42000", TerminateTLS: "example" }];
  for (const entry of entries) {
    const config: TailscaleServeConfig = { TCP: { "42000": entry } };
    const original = structuredClone(config);
    expect(() => ensureRegistryForward(config, 42000)).toThrow("belongs to another service");
    expect(removeRegistryForward(config, 42000)).toBe(false);
    expect(config).toEqual(original);
  }
  expect(() => ensureRegistryForward({ AllowFunnel: { "atelier.tailnet.ts.net:42000": true } }, 42000)).toThrow("Funnel");
  expect(() => ensureRegistryForward({ TCP: "invalid" }, 42000)).toThrow("not an object");
  expect(() => ensureRegistryForward({}, 41000)).toThrow();
});

test("owner discovers MagicDNS, persists only the port, republishes after restart/IP changes, and cleans up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "registry-serve-"));
  const socket = join(dir, "tailscale.sock");
  let config: TailscaleServeConfig = structuredClone(web);
  let address = "100.64.0.1";
  const server = Bun.serve({ unix: socket, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/status")) return Response.json({ BackendState: "Running", Self: { DNSName: "atelier.tailnet.ts.net.", TailscaleIPs: [address] } });
    expect(path).toBe("/localapi/v0/serve-config");
    if (req.method === "POST") { config = await req.json(); return new Response(""); }
    return Response.json(config);
  } });
  try {
    const runner = join(dir, "run.ts");
    await writeFile(runner, `import {prepareRegistry,releaseRegistry} from ${JSON.stringify(import.meta.dir + "/registry-runtime.ts")};
      const [operation]=process.argv.slice(2);
      if(operation==='prepare') console.log(await prepareRegistry(${JSON.stringify(dir)},${JSON.stringify(socket)}));
      else await releaseRegistry(${JSON.stringify(dir)},${JSON.stringify(socket)});`);
    const run = async (operation: string) => {
      const child = Bun.spawn([process.execPath, runner, operation], { env: { ...process.env, ATELIER_DATA_DIR: join(dir, "app") }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return stdout.trim();
    };
    const first = await run("prepare");
    expect(first).toMatch(/^atelier\.tailnet\.ts\.net:42[0-9]{3}$/);
    const port = Number(first.split(":")[1]);
    expect(JSON.parse(await readFile(join(dir, "registry-port"), "utf8"))).toBe(port);
    expect(config.TCP).toEqual({ ...web.TCP, [port]: { TCPForward: `127.0.0.1:${port}` } });
    expect(await run("prepare")).toBe(first);
    await run("release");
    expect(config).toEqual(web);
    address = "100.100.1.2";
    expect(await run("prepare")).toBe(first);
    expect(config.TCP).toEqual({ ...web.TCP, [port]: { TCPForward: `127.0.0.1:${port}` } });
    await run("release");
    expect(config).toEqual(web);
  } finally { await server.stop(true); await rm(dir, { recursive: true }); }
});
