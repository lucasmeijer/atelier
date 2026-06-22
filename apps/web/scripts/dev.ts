import { watch } from "node:fs";
import { resolve, sep } from "node:path";

const cwd = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(cwd, "../..");

let building = false;
let dirty = false;
let timer: Timer | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;

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
    return;
  }
  building = true;
  dirty = false;
  console.log("[assets] rebuilding…");
  const proc = Bun.spawn(["bun", "run", "build:assets"], { cwd, stdout: "pipe", stderr: "pipe" });
  prefixed("[assets]", proc.stdout);
  prefixed("[assets]", proc.stderr);
  const code = await proc.exited;
  building = false;
  console.log(code === 0 ? "[assets] ready" : `[assets] failed (${code})`);
  if (dirty) void runBuild();
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

function watchRecursive(path: string): void {
  watch(path, { recursive: true }, (_event, filename) => {
    const changed = filename ? resolve(path, filename.toString()) : path;
    if (!ignored(changed)) scheduleBuild();
  });
}

await runBuild();

watchRecursive(resolve(cwd, "src/client"));
watchRecursive(resolve(cwd, "public"));
watchRecursive(resolve(repoRoot, "packages"));
watch(resolve(cwd, "src/server/static-files.ts"), () => scheduleBuild());

server = Bun.spawn(["bun", "--watch", "run", "src/server/main.ts"], { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });

function shutdown(): void {
  server?.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.exited;
