import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rmdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import { HttpRequestBlockedError } from "../secrets/errors.ts";

const proxyAuthVersion = 1;
let proxyAuthFileLock: Promise<void> = Promise.resolve();

type ProxyAuthFile = { version: number; workspaces: Record<string, { token: string }> };

export async function ensureWorkspaceProxyAuthToken(workspaceId: string): Promise<string> {
  return await updateProxyAuthFile((file) => {
    const existing = file.workspaces[workspaceId]?.token;
    if (existing) return existing;
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    file.workspaces[workspaceId] = { token };
    return token;
  });
}

export async function forgetWorkspaceProxyAuthToken(workspaceId: string): Promise<void> {
  await updateProxyAuthFile((file) => {
    delete file.workspaces[workspaceId];
  });
}

export async function authenticateProxyRequest(req: IncomingMessage): Promise<string> {
  const header = req.headers["proxy-authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  const credentials = decodeProxyBasicAuth(value ?? "");
  if (!credentials) throw new HttpRequestBlockedError("proxy authentication required", 407, "Proxy Authentication Required");
  const file = await readProxyAuthFile();
  const expected = file.workspaces[credentials.username]?.token;
  if (!expected || !timingSafeEqual(credentials.password, expected)) throw new HttpRequestBlockedError("invalid proxy authentication", 407, "Proxy Authentication Required");
  return credentials.username;
}

function decodeProxyBasicAuth(value: string): { username: string; password: string } | undefined {
  const match = value.match(/^Basic\s+(\S+)$/i);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return undefined;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return nodeTimingSafeEqual(left, right);
}

async function updateProxyAuthFile<T>(update: (file: ProxyAuthFile) => T): Promise<T> {
  const previous = proxyAuthFileLock;
  let releaseProcessLock!: () => void;
  proxyAuthFileLock = new Promise<void>((resolve) => { releaseProcessLock = resolve; });
  await previous;

  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    const filePath = proxyAuthFilePath();
    releaseFileLock = await acquireProxyAuthFileLock(filePath);
    const file = readProxyAuthFileAt(filePath);
    const result = update(file);
    await writeProxyAuthFileAt(filePath, file);
    return result;
  } finally {
    await releaseFileLock?.();
    releaseProcessLock();
  }
}

async function readProxyAuthFile(): Promise<ProxyAuthFile> {
  return readProxyAuthFileAt(proxyAuthFilePath());
}

function readProxyAuthFileAt(path: string): ProxyAuthFile {
  if (!existsSync(path)) return { version: proxyAuthVersion, workspaces: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ProxyAuthFile;
  if (parsed.version !== proxyAuthVersion) throw new Error(`unsupported proxy auth file version: ${parsed.version}`);
  if (!parsed.workspaces || typeof parsed.workspaces !== "object") throw new Error("invalid proxy auth file: workspaces must be an object");
  return parsed;
}

async function writeProxyAuthFileAt(path: string, file: ProxyAuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

async function acquireProxyAuthFileLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      return async () => { await rmdir(lockDir).catch(() => {}); };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`timed out waiting for proxy auth lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function proxyAuthFilePath(): string {
  return atelierDataPath(getAtelierRuntimeContext(), "proxy", "workspace-auth.json");
}
