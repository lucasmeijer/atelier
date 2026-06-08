#!/usr/bin/env bun
import { CliError, invalidArguments, writeError } from "./json.ts";
import { workspaceCommand } from "./workspace.ts";

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
      await workspaceCommand(rest);
      return;
    default:
      throw invalidArguments(`unknown command: ${command}`);
  }
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  if (error instanceof CliError) {
    writeError({ code: error.code, message: error.message });
  } else {
    const message = error instanceof Error ? error.message : String(error);
    writeError({ code: "internal_error", message });
  }
  process.exit(1);
}
