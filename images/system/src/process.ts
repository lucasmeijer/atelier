import { spawn } from "node:child_process";

const commands = new Set<ReturnType<typeof spawn>>();
export function stopCommands() {
  for (const child of commands) child.kill("SIGTERM");
}

export async function command(
  args: string[],
  log?: (line: string) => void,
  onOutput?: (chunk: string) => void,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", () => clearTimeout(timer));
    commands.add(child);
    child.once("exit", () => commands.delete(child));
    const output: string[] = [];
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data: Buffer) => {
        const text = data.toString();
        output.push(text);
        onOutput?.(text);
        log?.(text.trimEnd());
      });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output.join("").trim())
        : reject(
            new Error(timedOut ? `Timed out after ${timeoutMs / 1000}s: ${args.join(" ")}` : `${args[0]} exited ${code}: ${output.join("").trim()}`),
          ),
    );
  });
}
export const docker = (...args: string[]) => command(["docker", ...args]);
export const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
