import { watch } from "node:fs";
import { relative, resolve, sep } from "node:path";

const cwd = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(cwd, "../..");

let building = false;
let dirty = false;
let buildPromise: Promise<void> | undefined;
let timer: Timer | undefined;
let serverRestartTimer: Timer | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let stoppingServer = false;
const pendingRestartReasons = new Set<string>();

function prefixed(prefix: string, stream: ReadableStream<Uint8Array> | null): void {
  if (!stream) return;
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) console.log(`${prefix} ${line}`);
    }
    pending += decoder.decode();
    if (pending) console.log(`${prefix} ${pending}`);
  })();
}

async function runBuild(): Promise<void> {
  if (building) {
    dirty = true;
    await buildPromise;
    return;
  }

  buildPromise = (async () => {
    do {
      building = true;
      dirty = false;
      console.log("[assets] rebuilding…");
      const proc = Bun.spawn(["bun", "run", "build:assets"], { cwd, stdout: "pipe", stderr: "pipe" });
      prefixed("[assets]", proc.stdout);
      prefixed("[assets]", proc.stderr);
      const code = await proc.exited;
      console.log(code === 0 ? "[assets] ready" : `[assets] failed (${code})`);
    } while (dirty);
    building = false;
    buildPromise = undefined;
  })();

  await buildPromise;
}

function scheduleBuild(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runBuild(), 100);
}

function ignored(path: string): boolean {
  const normalized = resolve(path);
  return normalized.includes(`${sep}node_modules${sep}`)
    || normalized.includes(`${sep}.git${sep}`)
    || normalized.includes(`${sep}apps${sep}web${sep}public${sep}assets${sep}`)
    || normalized.endsWith(`${sep}apps${sep}web${sep}public${sep}assets-manifest.json`)
    || normalized.endsWith(`${sep}apps${sep}web${sep}src${sep}client${sep}workspace-client-modules.generated.ts`)
    || normalized.endsWith(`${sep}apps${sep}web${sep}src${sep}server${sep}workspace-modules.generated.ts`);
}

function formatChangedPath(path: string): string {
  const rel = relative(repoRoot, path);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : path;
}

function rememberRestartReason(reason: string, changed: string): void {
  pendingRestartReasons.add(`${reason}: ${formatChangedPath(changed)}`);
}

function describeRestartReasons(): string {
  const reasons = [...pendingRestartReasons];
  pendingRestartReasons.clear();
  if (reasons.length === 0) return "manual restart";
  const shown = reasons.slice(0, 10);
  const suffix = reasons.length > shown.length ? ` (and ${reasons.length - shown.length} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

function isPackageRuntimeChange(path: string): boolean {
  const rel = relative(resolve(repoRoot, "packages"), path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  const [, firstPackagePathPart] = rel.split(sep);
  return firstPackagePathPart === "package.json" || firstPackagePathPart === "src";
}

function watchRecursive(path: string, onChange: (changed: string) => void): void {
  watch(path, { recursive: true }, (_event, filename) => {
    const changed = filename ? resolve(path, filename.toString()) : path;
    if (!ignored(changed)) onChange(changed);
  });
}

function startServer(): void {
  stoppingServer = false;
  server = Bun.spawn(["bun", "run", "src/server/main.ts"], { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  void (async () => {
    const code = await server!.exited;
    if (stoppingServer) return;
    process.exit(code ?? 1);
  })();
}

async function restartServer(): Promise<void> {
  const why = describeRestartReasons();
  if (!server) {
    console.log(`[server] starting (${why})`);
    startServer();
    return;
  }
  console.log(`[server] restarting (${why})`);
  stoppingServer = true;
  server.kill();
  await server.exited.catch(() => {});
  startServer();
}

function scheduleServerRestart(reason: string, changed: string): void {
  rememberRestartReason(reason, changed);
  if (serverRestartTimer) clearTimeout(serverRestartTimer);
  serverRestartTimer = setTimeout(() => void restartServer(), 100);
}

function scheduleBuildThenServerRestart(reason: string, changed: string): void {
  rememberRestartReason(reason, changed);
  if (serverRestartTimer) clearTimeout(serverRestartTimer);
  if (timer) clearTimeout(timer);
  serverRestartTimer = setTimeout(() => void (async () => {
    await runBuild();
    await restartServer();
  })(), 100);
}

await runBuild();

watchRecursive(resolve(cwd, "src/client"), () => scheduleBuild());
watchRecursive(resolve(cwd, "public"), () => scheduleBuild());
watchRecursive(resolve(cwd, "src/server"), (changed) => {
  if (changed.endsWith(`${sep}static-files.ts`)) scheduleBuildThenServerRestart("server static file list changed", changed);
  else scheduleServerRestart("server source changed", changed);
});
watchRecursive(resolve(repoRoot, "packages"), (changed) => {
  if (isPackageRuntimeChange(changed)) scheduleBuildThenServerRestart("shared package runtime changed", changed);
});

startServer();

function shutdown(): void {
  stoppingServer = true;
  server?.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});
