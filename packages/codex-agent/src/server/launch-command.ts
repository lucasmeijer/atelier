import { parseModelRef } from "@atelier/llm/server";
import { cliLaunchScript, type CliModelSettings } from "@atelier/cli-agent/server";
import { workspaceRoot } from "@atelier/workspace";
import type { WorkspaceAgentInput } from "@atelier/shared";

/** Run inside tmux so installation progress and failures stay visible in the tab. */
export function codexLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings = {}, turnFinishedCommand?: string): string {
  const prompt = [input.text, ...input.attachmentNotes].filter(Boolean).join("\n\n");
  // Invocation-local overrides avoid trust/update prompts without changing shared config.
  // Codex splits dotted keys literally, so encode project paths in a TOML table value.
  // Config overrides also keep current Codex on its embedded server rather than a shared daemon.
  const args = ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--no-alt-screen", "--cd", workspaceRoot,
    "-c", `projects={${JSON.stringify(workspaceRoot)}={trust_level="trusted"}}`,
    ...(turnFinishedCommand ? ["-c", `notify=${JSON.stringify(["sh", turnFinishedCommand])}`] : []),
    "-c", "notice.hide_full_access_warning=true", "-c", "check_for_update_on_startup=false",
    "-c", 'cli_auth_credentials_store="file"', ...(settings.model ? ["--model", parseModelRef(settings.model)!.id] : []),
    ...(settings.thinkingLevel ? ["-c", `model_reasoning_effort=${JSON.stringify(settings.thinkingLevel)}`] : []),
    ...imagePaths.flatMap((path) => ["--image", path]), ...(prompt ? ["--", prompt] : [])];
  return cliLaunchScript({ executable: "codex", label: "Codex", npmPackage: "@openai/codex", args });
}
