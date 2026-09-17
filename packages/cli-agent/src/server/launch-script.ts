import { shellQuote } from "@atelier/core";
import { workspaceRoot } from "@atelier/workspace";

/** Install once in shared home, then launch in tmux with visible startup diagnostics. */
export function cliLaunchScript(options: { executable: string; label: string; npmPackage: string; version?: string; args: string[]; setup?: string }): string {
  const { executable, label, npmPackage, version, args, setup = "" } = options;
  // A pinned CLI must not reuse a different version from PATH or the unversioned install.
  const directory = `$HOME/.${executable}-cli${version ? `/${version}` : ""}`;
  const resolveExecutable = version ? `executable="${directory}/node_modules/.bin/${executable}"` : `executable="$(command -v ${executable} || true)"
case "$executable" in "$HOME"/*) ;; *) executable="$HOME/.local/bin/${executable}" ;; esac`;
  const linkExecutable = version ? "" : `mkdir -p "$HOME/.local/bin"
  ln -s "$HOME/.${executable}-cli/node_modules/.bin/${executable}" "$HOME/.local/bin/${executable}"`;
  return `set -eu
failure_message=${shellQuote(`\n${label} failed (exit %s). See the error above.\n`)}
trap 'code=$?; if [ "$code" -ne 0 ]; then printf "$failure_message" "$code"; fi' EXIT
# Installation and its lock live in shared home, not workspace-private .local/share.
(
  flock 9
  ${resolveExecutable}
  if [ -x "$executable" ]; then exit 0; fi
  mkdir -p "$(dirname "${directory}")"
  printf '%s\\n' ${shellQuote(`Installing ${version ? `${label} ${version}` : `latest ${label}`} into shared home…`)}
  staging="$(mktemp -d "$HOME/.${executable}-cli-install.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  npm install --prefix "$staging" --no-audit --no-fund ${shellQuote(`${npmPackage}@${version ?? "latest"}`)}
  mv "$staging" "${directory}"
  ${linkExecutable}
) 9> "$HOME/.${executable}-cli-install.lock"
${setup}
${resolveExecutable}
cd ${shellQuote(workspaceRoot)}
"$executable" ${args.map(shellQuote).join(" ")}
`;
}
