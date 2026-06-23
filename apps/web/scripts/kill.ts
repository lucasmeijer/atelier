import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const selfPid = process.pid;
const termWaitMs = 1_000;

interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
  kind: "dev" | "server";
}

async function processList(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): ProcessInfo[] => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) return [];
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const command = match[3];
      const kind = atelierProcessKind(command);
      if (!kind || pid === selfPid) return [];
      return [{ pid, ppid, command, kind }];
    });
}

function atelierProcessKind(command: string): ProcessInfo["kind"] | undefined {
  if (!/\bbun\b/.test(command)) return undefined;

  if (
    command.includes("apps/web/scripts/dev.ts")
    || command.includes("scripts/dev.ts")
    || command.includes("bun run --cwd apps/web dev")
    || command.includes("bun run web")
  ) return "dev";

  if (
    command.includes("apps/web/src/server/main.ts")
    || command.includes("src/server/main.ts")
  ) return "server";

  return undefined;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const matches = await processList();
  if (matches.length === 0) {
    console.log("No Atelier web servers found.");
    return;
  }

  const ordered = matches.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dev" ? -1 : 1;
    return a.pid - b.pid;
  });

  for (const proc of ordered) {
    console.log(`Stopping Atelier ${proc.kind} process ${proc.pid}: ${proc.command}`);
    signal(proc.pid, "SIGTERM");
  }

  await sleep(termWaitMs);

  const stubborn = ordered.filter((proc) => isRunning(proc.pid));
  for (const proc of stubborn) {
    console.log(`Force killing Atelier ${proc.kind} process ${proc.pid}`);
    signal(proc.pid, "SIGKILL");
  }

  console.log(`Stopped ${ordered.length} Atelier process${ordered.length === 1 ? "" : "es"}.`);
}

await main();
