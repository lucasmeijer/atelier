import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { atelierDataPath, createProcessFileLock, getAtelierRuntimeContext, isJsonObject, type JsonObject } from "@atelier/core";
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

export type TailscaleServeConfig = JsonObject;

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
  const tcp = ensureRecord(config, "TCP");
  const currentTcp = tcp[portKey];
  if (currentTcp !== undefined && !isCompatibleTcpHttpsEntry(currentTcp)) throw new Error(`Tailscale Serve TCP port ${options.port} is already configured for another service`);

  let changed = false;
  if (!isObject(currentTcp) || (currentTcp as { HTTPS?: unknown }).HTTPS !== true) {
    tcp[portKey] = { HTTPS: true };
    changed = true;
  }

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
  const parsed: unknown = JSON.parse(body || "{}");
  if (!isJsonObject(parsed)) throw new Error("Tailscale Serve config response is not an object");
  return parsed;
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
  const web = ensureRecord(config, "Web");
  const key = webKey(host, port);
  const currentEntry = web[key];
  if (currentEntry !== undefined && !isObject(currentEntry)) throw new Error(`Tailscale Serve web route ${key} is already configured for another service`);

  const entry: JsonObject = currentEntry ?? {};
  const currentHandlers = entry.Handlers;
  if (currentHandlers !== undefined && !isObject(currentHandlers)) throw new Error(`Tailscale Serve web route ${key} handlers are not an object`);

  const handlers: JsonObject = currentHandlers ?? {};
  const target = proxyTarget(port, targetHost);
  const root = handlers["/"];
  if (root !== undefined && !isProxyHandler(root, target)) throw new Error(`Tailscale Serve web route ${key}/ is already configured for another service`);
  if (isProxyHandler(root, target)) return false;

  handlers["/"] = { Proxy: target };
  entry.Handlers = handlers;
  web[key] = entry;
  return true;
}

function pruneManagedPort(config: TailscaleServeConfig, port: number, options: { desiredHost: string; active: boolean; targetHost: string }): boolean {
  let changed = false;
  const key = webKey(options.desiredHost, port);
  const target = proxyTarget(port, options.targetHost);

  if (!options.active && isObject(config.Web) && removeOwnedRootHandler(config.Web[key], target)) {
    if (isEmptyWebEntry(config.Web[key])) delete config.Web[key];
    if (Object.keys(config.Web).length === 0) delete config.Web;
    changed = true;
  }

  if (!options.active && isObject(config.TCP)) {
    const tcpKey = String(port);
    if (Object.prototype.hasOwnProperty.call(config.TCP, tcpKey) && isCompatibleTcpHttpsEntry(config.TCP[tcpKey]) && !hasWebEntryForPort(config, port)) {
      delete config.TCP[tcpKey];
      if (Object.keys(config.TCP).length === 0) delete config.TCP;
      changed = true;
    }
  }

  return changed;
}

function removeOwnedRootHandler(value: unknown, target: string): boolean {
  if (!isObject(value) || !isObject(value.Handlers)) return false;
  if (!isProxyHandler(value.Handlers["/"], target)) return false;
  delete value.Handlers["/"];
  if (Object.keys(value.Handlers).length === 0) delete value.Handlers;
  return true;
}

function isEmptyWebEntry(value: unknown): boolean {
  return isObject(value) && (!isObject(value.Handlers) || Object.keys(value.Handlers).length === 0) && Object.keys(value).every((key) => key === "Handlers");
}

function hasWebEntryForPort(config: TailscaleServeConfig, port: number): boolean {
  return isObject(config.Web) && Object.keys(config.Web).some((key) => webKeyPort(key) === port);
}

function isCompatibleTcpHttpsEntry(value: unknown): boolean {
  return value === undefined || (isObject(value) && value.HTTPS === true);
}

function isProxyHandler(value: unknown, target: string): boolean {
  return isObject(value) && value.Proxy === target;
}

function ensureRecord(config: TailscaleServeConfig, key: "TCP" | "Web"): JsonObject {
  const value = config[key];
  if (value === undefined) {
    const record: JsonObject = {};
    config[key] = record;
    return record;
  }
  if (!isObject(value)) throw new Error(`Tailscale Serve config ${key} field is not an object`);
  return value;
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

const isObject = isJsonObject;
