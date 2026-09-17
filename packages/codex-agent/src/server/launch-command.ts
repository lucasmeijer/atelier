import { parseModelRef } from "@atelier/llm/server";
import type { CodexLaunchSettings } from "./model-settings.ts";
import { shellQuote } from "@atelier/core";
import { workspaceRoot } from "@atelier/workspace";
import type { WorkspaceAgentInput } from "@atelier/shared";

/** Run inside tmux so installation progress and failures stay visible in the tab. */
export function codexLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CodexLaunchSettings = {}): string {
  const prompt = [input.text, ...input.attachmentNotes].filter(Boolean).join("\n\n");
  // Invocation-local overrides avoid trust/update prompts without changing shared config.
  // Codex splits dotted keys literally, so encode project paths in a TOML table value.
  // Config overrides also keep current Codex on its embedded server rather than a shared daemon.
  const args = ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--no-alt-screen", "--cd", workspaceRoot,
    "-c", `projects={${JSON.stringify(workspaceRoot)}={trust_level="trusted"}}`,
    "-c", "notice.hide_full_access_warning=true", "-c", "check_for_update_on_startup=false",
    "-c", 'cli_auth_credentials_store="file"', ...(settings.model ? ["--model", parseModelRef(settings.model)!.id] : []),
    ...(settings.thinkingLevel ? ["-c", `model_reasoning_effort=${JSON.stringify(settings.thinkingLevel)}`] : []),
    ...imagePaths.flatMap((path) => ["--image", path]), ...(prompt ? ["--", prompt] : [])];
  return `set -eu
trap 'code=$?; if [ "$code" -ne 0 ]; then printf "\\nCodex failed (exit %s). See the error above.\\n" "$code"; fi' EXIT
# Installation and its lock live in shared home, not workspace-private .local/share.
(
  flock 9
  executable="$(command -v codex || true)"
  case "$executable" in "$HOME"/*) exit 0 ;; esac
  if [ -x "$HOME/.local/bin/codex" ]; then exit 0; fi
  printf 'Installing latest Codex into shared home…\\n'
  staging="$(mktemp -d "$HOME/.codex-cli-install.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  npm install --prefix "$staging" --no-audit --no-fund @openai/codex@latest
  mv "$staging" "$HOME/.codex-cli"
  mkdir -p "$HOME/.local/bin"
  ln -s "$HOME/.codex-cli/node_modules/.bin/codex" "$HOME/.local/bin/codex"
) 9> "$HOME/.codex-cli-install.lock"
executable="$(command -v codex || true)"
case "$executable" in "$HOME"/*) ;; *) executable="$HOME/.local/bin/codex" ;; esac
"$executable" ${args.map(shellQuote).join(" ")}
`;
}
