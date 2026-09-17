import { shellQuote } from "@atelier/core";
import { workspaceRoot } from "@atelier/workspace";

/** Install once in shared home, then launch in tmux with visible startup diagnostics. */
export function cliLaunchScript(options: { executable: string; label: string; npmPackage: string; args: string[]; setup?: string }): string {
  const { executable, label, npmPackage, args, setup = "" } = options;
  return `set -eu
failure_message=${shellQuote(`\n${label} failed (exit %s). See the error above.\n`)}
trap 'code=$?; if [ "$code" -ne 0 ]; then printf "$failure_message" "$code"; fi' EXIT
# Installation and its lock live in shared home, not workspace-private .local/share.
(
  flock 9
  executable="$(command -v ${executable} || true)"
  case "$executable" in "$HOME"/*) exit 0 ;; esac
  if [ -x "$HOME/.local/bin/${executable}" ]; then exit 0; fi
  printf '%s\\n' ${shellQuote(`Installing latest ${label} into shared home…`)}
  staging="$(mktemp -d "$HOME/.${executable}-cli-install.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  npm install --prefix "$staging" --no-audit --no-fund ${shellQuote(`${npmPackage}@latest`)}
  mv "$staging" "$HOME/.${executable}-cli"
  mkdir -p "$HOME/.local/bin"
  ln -s "$HOME/.${executable}-cli/node_modules/.bin/${executable}" "$HOME/.local/bin/${executable}"
) 9> "$HOME/.${executable}-cli-install.lock"
${setup}
executable="$(command -v ${executable} || true)"
case "$executable" in "$HOME"/*) ;; *) executable="$HOME/.local/bin/${executable}" ;; esac
cd ${shellQuote(workspaceRoot)}
"$executable" ${args.map(shellQuote).join(" ")}
`;
}
