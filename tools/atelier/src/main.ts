#!/usr/bin/env bun
import { AtelierCoreError, createAtelierEventBus, invalidArguments } from "@atelier/core";
import { registerRepositoryWorkspaceEvents, workspaceRepoCommand } from "@atelier/repository";
import { workspaceCommand } from "@atelier/workspace";
import { registerWorkspaceProxyEvents } from "@atelier/workspace-proxy";
import { registerTerminalEvents } from "@atelier/workspace-terminal/server";
import { registerVSCodeEvents } from "@atelier/vscode/server";
import { writeError, writeSuccess } from "./json.ts";

const atelierEvents = createAtelierEventBus();
registerRepositoryWorkspaceEvents(atelierEvents);
registerWorkspaceProxyEvents(atelierEvents);
registerTerminalEvents(atelierEvents);
registerVSCodeEvents(atelierEvents);

function usage(): string {
  return `atelier [--help]\n\nAtelier command-line tool.\n\nOptions:\n  -h, --help    Show this help\n`;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      if (rest.length > 0) throw invalidArguments(`unexpected arguments: ${rest.join(" ")}`);
      process.stdout.write(usage());
      return;
    case "workspace":
      writeSuccess(await (rest[1] === "repo" ? workspaceRepoCommand(rest) : workspaceCommand(rest, { events: atelierEvents })));
      return;
    default:
      throw invalidArguments(`unknown command: ${command}`);
  }
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  if (error instanceof AtelierCoreError) {
    writeError({ code: error.code, message: error.message, details: error.details });
  } else {
    const message = error instanceof Error ? error.message : String(error);
    writeError({ code: "internal_error", message });
  }
  process.exit(1);
}
