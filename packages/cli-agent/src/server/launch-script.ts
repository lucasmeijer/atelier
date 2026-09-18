import { shellQuote } from "@atelier/core";
import { workspaceRoot } from "@atelier/workspace";

/** Install once in shared home, then launch in tmux with visible startup diagnostics. */
export function cliLaunchScript(options: { executable: string; label: string; npmPackage: string; version?: string; installDirectory?: string; args: string[]; setup?: string }): string {
  const { executable, label, npmPackage, version, installDirectory, args, setup = "" } = options;
  // Pinned versions and explicit install directories must not reuse a different install from PATH.
  const directory = installDirectory ? `$HOME/${installDirectory}` : `$HOME/.${executable}-cli${version ? `/${version}` : ""}`;
  const resolveExecutable = version || installDirectory ? `executable="${directory}/node_modules/.bin/${executable}"` : `executable="$(command -v ${executable} || true)"
case "$executable" in "$HOME"/*) ;; *) executable="$HOME/.local/bin/${executable}" ;; esac`;
  const linkExecutable = version ? "" : `mkdir -p "$HOME/.local/bin"
  ln -s${installDirectory ? "f" : ""} "${directory}/node_modules/.bin/${executable}" "$HOME/.local/bin/${executable}"`;
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
