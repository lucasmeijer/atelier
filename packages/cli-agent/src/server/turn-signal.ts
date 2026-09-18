import { shellQuote } from "@atelier/core";

/** Turn boundary reported to Atelier: a started turn marks the conversation busy, a finished one marks it unread. */
export type TurnBoundary = "started" | "finished";

/** Every session gets one signal script, invoked as `sh <script> <boundary>`. */
export function turnSignalArgv(command: string, boundary: TurnBoundary): string[] {
  return ["sh", command, boundary];
}

/** The same invocation for CLIs that take a shell command line rather than an argument vector. */
export function turnSignalShell(command: string, boundary: TurnBoundary): string {
  return `sh ${shellQuote(command)} ${boundary}`;
}
