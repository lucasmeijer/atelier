import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { atelierDataPath, createProcessFileLock, getAtelierRuntimeContext } from "@atelier/core";
import { defaultPublicProxyPortRange, type PublicProxyPortRange } from "./route-state.ts";

export const defaultTailscaleLocalApiSocketPath = "/var/run/tailscale/tailscaled.sock";
export const defaultTailscaleServeHelperPath = "/usr/local/bin/atelier-tailscale-serve-helper";

export interface PublicProxyPortExposer {
  ensurePort(port: number): Promise<void>;
  releasePort(port: number): Promise<void>;
  syncPorts(ports: Iterable<number>): Promise<void>;
}

export interface TailscaleServePortExposerOptions {
  host: string;
  socketPath?: string;
  portRange?: PublicProxyPortRange;
  targetHost?: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

type TailscaleServeTcpPortConfig = JsonObject & {
  HTTPS?: boolean;
  TCPForward?: string;
  TerminateTLS?: string;
};

interface TailscaleServeTcpConfig {
  [port: string]: TailscaleServeTcpPortConfig;
}

type TailscaleServeWebHandler = JsonObject & {
  Proxy?: string;
  Text?: string;
  Path?: string;
};

type TailscaleServeWebEntry = JsonObject & {
  Handlers?: { [path: string]: TailscaleServeWebHandler };
};

interface TailscaleServeWebConfig {
  [hostPort: string]: TailscaleServeWebEntry;
}

export type TailscaleServeConfig = JsonObject & {
  TCP?: TailscaleServeTcpConfig;
  Web?: TailscaleServeWebConfig;
};

type ServeConfigMutator = (config: TailscaleServeConfig) => boolean;

const withTailscaleServeLock = createProcessFileLock({
  label: "Tailscale Serve config",
  lockDir: () => atelierDataPath(getAtelierRuntimeContext(), "proxy", "tailscale-serve.lock"),
});

export function createTailscaleServePortExposer(options: TailscaleServePortExposerOptions): PublicProxyPortExposer {
  const host = normalizeServeHost(options.host);
  const socketPath = options.socketPath ?? defaultTailscaleLocalApiSocketPath;
  const portRange = options.portRange ?? defaultPublicProxyPortRange;
  const targetHost = options.targetHost ?? "127.0.0.1";

  if (shouldUseSudoTailscaleServeHelper(socketPath, portRange, targetHost)) return createSudoTailscaleServePortExposer({ host });

  return {
    async ensurePort(port) {
      validateManagedPort(port, portRange);
      await mutateTailscaleServeConfig(socketPath, (config) => ensureTailscaleServePortConfig(config, { host, port, targetHost }));
    },
    async releasePort(port) {
      validateManagedPort(port, portRange);
      await mutateTailscaleServeConfig(socketPath, (config) => pruneTailscaleServePortConfig(config, { host, port, targetHost }));
    },
    async syncPorts(ports) {
      await mutateTailscaleServeConfig(socketPath, (config) => syncTailscaleServePortConfig(config, { host, activePorts: managedPortSet(ports, portRange), portRange, targetHost }));
    },
  };
}

function shouldUseSudoTailscaleServeHelper(socketPath: string, portRange: PublicProxyPortRange, targetHost: string): boolean {
  return process.getuid?.() !== 0
    && socketPath === defaultTailscaleLocalApiSocketPath
    && targetHost === "127.0.0.1"
    && samePortRange(portRange, defaultPublicProxyPortRange);
}

function createSudoTailscaleServePortExposer(options: { host: string }): PublicProxyPortExposer {
  return {
    async ensurePort(port) {
      validateManagedPort(port, defaultPublicProxyPortRange);
      await runSudoTailscaleServeHelper(["ensure", options.host, String(port)]);
    },
    async releasePort(port) {
      validateManagedPort(port, defaultPublicProxyPortRange);
      await runSudoTailscaleServeHelper(["release", options.host, String(port)]);
    },
    async syncPorts(ports) {
      await runSudoTailscaleServeHelper(["sync", options.host, ...[...managedPortSet(ports, defaultPublicProxyPortRange)].map((port) => String(port))]);
    },
  };
}

function managedPortSet(ports: Iterable<number>, range: PublicProxyPortRange): Set<number> {
  const result = new Set<number>();
  for (const port of ports) {
    validateManagedPort(port, range);
    result.add(port);
  }
  return result;
}

function samePortRange(a: PublicProxyPortRange, b: PublicProxyPortRange): boolean {
  return a.start === b.start && a.end === b.end;
}

async function runSudoTailscaleServeHelper(args: string[]): Promise<void> {
  const result = await spawnBuffered("sudo", ["-n", defaultTailscaleServeHelperPath, ...args]);
  if (result.exitCode !== 0) throw new Error(`Tailscale Serve helper failed: ${result.stderr || result.stdout}`.trim());
}

function spawnBuffered(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({
      exitCode: exitCode ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8").trim(),
      stderr: Buffer.concat(stderr).toString("utf8").trim(),
    }));
  });
}

export function ensureTailscaleServePortConfig(config: TailscaleServeConfig, options: { host: string; port: number; targetHost?: string }): boolean {
  const host = normalizeServeHost(options.host);
  const targetHost = options.targetHost ?? "127.0.0.1";
  const portKey = String(options.port);
  const tcp = config.TCP ??= {};
  const currentTcp = tcp[portKey];
  if (currentTcp && currentTcp.HTTPS !== true) throw new Error(`Tailscale Serve TCP port ${options.port} is already configured for another service`);

  const changed = currentTcp === undefined;
  if (changed) tcp[portKey] = { HTTPS: true };

  return ensureWebProxyHandler(config, host, options.port, targetHost) || changed;
}

export function pruneTailscaleServePortConfig(config: TailscaleServeConfig, options: { host: string; port: number; targetHost?: string }): boolean {
  const host = normalizeServeHost(options.host);
  const targetHost = options.targetHost ?? "127.0.0.1";
  return pruneManagedPort(config, options.port, { desiredHost: host, active: false, targetHost });
}

export function syncTailscaleServePortConfig(config: TailscaleServeConfig, options: { host: string; activePorts: Set<number>; portRange?: PublicProxyPortRange; targetHost?: string }): boolean {
  const host = normalizeServeHost(options.host);
  const portRange = options.portRange ?? defaultPublicProxyPortRange;
  const targetHost = options.targetHost ?? "127.0.0.1";
  let changed = false;
  for (let port = portRange.start; port <= portRange.end; port++) {
    changed = pruneManagedPort(config, port, { desiredHost: host, active: options.activePorts.has(port), targetHost }) || changed;
  }
  for (const port of options.activePorts) changed = ensureTailscaleServePortConfig(config, { host, port, targetHost }) || changed;
  return changed;
}

export async function mutateTailscaleServeConfig(socketPath: string, mutator: ServeConfigMutator): Promise<void> {
  await withTailscaleServeLock(async () => {
    const config = await readTailscaleServeConfig(socketPath);
    if (!mutator(config)) return;
    await writeTailscaleServeConfig(socketPath, config);
  });
}

async function readTailscaleServeConfig(socketPath: string): Promise<TailscaleServeConfig> {
  const body = await tailscaleLocalApiRequest(socketPath, "GET", "/localapi/v0/serve-config");
  return parseTailscaleServeConfig(body);
}

export function parseTailscaleServeConfig(json: string): TailscaleServeConfig {
  const config = parseJsonObject(JSON.parse(json || "{}"), "Tailscale Serve config response");
  if (config.TCP !== undefined) parseTcpConfig(config.TCP);
  if (config.Web !== undefined) parseWebConfig(config.Web);
  return config as TailscaleServeConfig;
}

function parseTcpConfig(value: JsonValue): asserts value is TailscaleServeTcpConfig {
  const tcp = parseJsonObject(value, "Tailscale Serve config TCP field");
  for (const [port, rawEntry] of Object.entries(tcp)) {
    const context = `Tailscale Serve TCP port ${port}`;
    const entry = parseJsonObject(rawEntry, context);
    assertOptionalFieldType(entry, "HTTPS", "boolean", context);
    assertOptionalFieldType(entry, "TCPForward", "string", context);
    assertOptionalFieldType(entry, "TerminateTLS", "string", context);
  }
}

function parseWebConfig(value: JsonValue): asserts value is TailscaleServeWebConfig {
  const web = parseJsonObject(value, "Tailscale Serve config Web field");
  for (const [hostPort, rawEntry] of Object.entries(web)) {
    const entry = parseJsonObject(rawEntry, `Tailscale Serve web route ${hostPort}`);
    if (entry.Handlers === undefined) continue;
    const handlers = parseJsonObject(entry.Handlers, `Tailscale Serve web route ${hostPort} handlers`);
    for (const [path, rawHandler] of Object.entries(handlers)) {
      const context = `Tailscale Serve web route ${hostPort}${path}`;
      const handler = parseJsonObject(rawHandler, context);
      for (const field of ["Proxy", "Text", "Path"] as const) assertOptionalFieldType(handler, field, "string", context);
    }
  }
}

async function writeTailscaleServeConfig(socketPath: string, config: TailscaleServeConfig): Promise<void> {
  await tailscaleLocalApiRequest(socketPath, "POST", "/localapi/v0/serve-config", `${JSON.stringify(config)}\n`);
}

export async function tailscaleLocalApiRequest(socketPath: string, method: "GET" | "POST", path: string, body?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const headers = body === undefined
      ? { host: "local-tailscaled.sock" }
      : { host: "local-tailscaled.sock", "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() };
    const req = httpRequest({
      socketPath,
      method,
      path,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) reject(new Error(`Tailscale local API ${method} ${path} failed with HTTP ${status}: ${text.trim()}`));
        else resolve(text);
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function ensureWebProxyHandler(config: TailscaleServeConfig, host: string, port: number, targetHost: string): boolean {
  const web = config.Web ??= {};
  const key = webKey(host, port);
  const entry = web[key] ?? {};
  const handlers = entry.Handlers ?? {};
  const target = proxyTarget(port, targetHost);
  const root = handlers["/"];
  if (root) {
    if (root.Proxy !== target) throw new Error(`Tailscale Serve web route ${key}/ is already configured for another service`);
    return false;
  }

  handlers["/"] = { Proxy: target };
  entry.Handlers = handlers;
  web[key] = entry;
  return true;
}

function pruneManagedPort(config: TailscaleServeConfig, port: number, options: { desiredHost: string; active: boolean; targetHost: string }): boolean {
  let changed = false;
  const key = webKey(options.desiredHost, port);
  const target = proxyTarget(port, options.targetHost);

  const web = config.Web;
  const webEntry = web?.[key];
  if (!options.active && web && webEntry && removeOwnedRootHandler(webEntry, target)) {
    if (isEmptyWebEntry(webEntry)) delete web[key];
    if (Object.keys(web).length === 0) delete config.Web;
    changed = true;
  }

  const tcp = config.TCP;
  const tcpKey = String(port);
  if (!options.active && tcp?.[tcpKey]?.HTTPS === true && !hasWebEntryForPort(config, port)) {
    delete tcp[tcpKey];
    if (Object.keys(tcp).length === 0) delete config.TCP;
    changed = true;
  }

  return changed;
}

function removeOwnedRootHandler(entry: TailscaleServeWebEntry, target: string): boolean {
  if (entry.Handlers?.["/"]?.Proxy !== target) return false;
  delete entry.Handlers["/"];
  if (Object.keys(entry.Handlers).length === 0) delete entry.Handlers;
  return true;
}

function isEmptyWebEntry(entry: TailscaleServeWebEntry): boolean {
  return (!entry.Handlers || Object.keys(entry.Handlers).length === 0) && Object.keys(entry).every((key) => key === "Handlers");
}

function hasWebEntryForPort(config: TailscaleServeConfig, port: number): boolean {
  return config.Web !== undefined && Object.keys(config.Web).some((key) => webKeyPort(key) === port);
}

export function validateManagedPort(port: number, range: PublicProxyPortRange): void {
  if (!Number.isInteger(port) || port < range.start || port > range.end) throw new Error(`Tailscale Serve port ${port} is outside the managed proxy range ${range.start}-${range.end}`);
}

export function normalizeServeHost(host: string): string {
  const trimmed = host.trim().replace(/\.$/, "");
  if (!trimmed) throw new Error("Tailscale Serve host is empty");
  if (trimmed.includes(":")) return new URL(`https://${trimmed}`).hostname;
  return trimmed;
}

function webKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function webKeyPort(key: string): number | undefined {
  const match = key.match(/:(\d+)$/);
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) ? port : undefined;
}

function proxyTarget(port: number, targetHost: string): string {
  return `http://${targetHost}:${port}/`;
}

function assertOptionalFieldType(object: JsonObject, field: string, type: "boolean" | "string", context: string): void {
  if (object[field] !== undefined && typeof object[field] !== type) throw new Error(`${context} ${field} field is not a ${type}`);
}

function parseJsonObject(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} is not an object`);
  return value as JsonObject;
}
