#!/usr/bin/env bun
export {};

function usage(): string {
  return `atelier [--help]\n\nAtelier command-line tool.\n\nOptions:\n  -h, --help    Show this help\n`;
}

async function main(argv: string[]): Promise<void> {
  const [option, ...rest] = argv;

  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}\n\n${usage()}`);
  }

  switch (option) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage());
      return;
    default:
      throw new Error(`Unknown option: ${option}\n\n${usage()}`);
  }
}

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`atelier: ${message}\n`);
  process.exit(1);
}
