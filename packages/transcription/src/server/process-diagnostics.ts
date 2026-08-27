import { stripVTControlCharacters } from "node:util";

const diagnosticLimit = 2_000;

export async function captureProcessStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stderr.write(value);
    tail = `${tail}${decoder.decode(value, { stream: true })}`.slice(-diagnosticLimit);
  }
  tail = `${tail}${decoder.decode()}`.slice(-diagnosticLimit);
  return stripVTControlCharacters(tail).trim();
}

function exitCodeDescription(exitCode: number): string | undefined {
  switch (exitCode) {
    case 1: return "runtime failure";
    case 2: return "invalid argument or configuration";
    case 3: return "model missing";
    case 4: return "feature unavailable";
  }
}

export function processExitMessage(name: string, exitCode: number, stderr: string): string {
  const description = exitCodeDescription(exitCode);
  const summary = stderr.trim();
  return `${name} exited with code ${exitCode}${description ? ` (${description})` : ""}${summary ? `:\n${summary}` : ""}`;
}
