import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { shellQuote } from "@atelier/core";

const compilerFlags = "-O2 -std=c11 -Wall -Wextra -Wpedantic -Werror -x c - -lm";
const cacheDirectory = "/.atelier/terminal-intro";

/** Install on demand into existing workspaces, independent of their image.
 * Compiling inside the workspace also selects its own architecture/libc.
 * A content-addressed executable and atomic rename allow concurrent creates.
 */
export async function newInteractiveTerminalCommand(): Promise<{ setup: string; command: string }> {
  const source = await readFile(new URL("./intro/main.c", import.meta.url), "utf8");
  const hash = createHash("sha256").update(compilerFlags).update(source).digest("hex");
  const executable = `${cacheDirectory}/${hash}`;
  const setup = `set -eu
mkdir -p ${shellQuote(cacheDirectory)}
if [ ! -x ${shellQuote(executable)} ]; then
  temporary=$(mktemp ${shellQuote(`${cacheDirectory}/build.XXXXXX`)})
  trap 'rm -f "$temporary"' EXIT
  printf %s ${shellQuote(source)} | cc ${compilerFlags} -o "$temporary"
  mv "$temporary" ${shellQuote(executable)}
fi`;

  // A new session starts detached. Do not spend the animation before its first
  // viewer arrives. The wait belongs to this one shell, not the attach path:
  // reconnection, server restart, and attaching existing sessions cannot replay it.
  const script = `set -e
while :; do
  attached=$(tmux display-message -p -t "$TMUX_PANE" '#{session_attached}')
  if [ "$attached" -gt 0 ]; then break; fi
  sleep 0.01
done
set +e
${shellQuote(executable)}
exec /bin/bash`;
  // Run setup in the same container call as tmux creation, not a separate
  // Docker exec round trip. Compilation errors still abort terminal creation.
  return { setup, command: `/bin/bash -c ${shellQuote(script)}` };
}
