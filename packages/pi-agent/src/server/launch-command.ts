import { VERSION } from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "@atelier/llm/server";
import { cliLaunchScript, type CliAgentSession, type CliModelSettings } from "@atelier/cli-agent/server";
import type { WorkspaceAgentInput } from "@atelier/shared";
import { piAtelierExtensionPath } from "./mcp.ts";

/** Pin the CLI to Atelier's Pi runtime so auth formats and model capabilities agree. */
export function piLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings = {}, session?: CliAgentSession): string {
  const prompt = [input.text, ...input.attachmentNotes].filter(Boolean).join("\n\n");
  const model = settings.model ? parseModelRef(settings.model)! : undefined;
  // Pi treats @-prefixed positionals as file attachments even after --.
  const message = prompt.startsWith("@") ? `\n${prompt}` : prompt;
  const args = ["--approve", "--offline", "--tui-mode", "regular", "--session-dir", "/home/atelier/.local/share/pi/sessions",
    ...(session ? ["--extension", piAtelierExtensionPath(session.id)] : []),
    ...(model ? ["--provider", model.provider, "--model", model.id] : []),
    ...(settings.thinkingLevel ? ["--thinking", settings.thinkingLevel] : []),
    "--", ...imagePaths.map((path) => `@${path}`), ...(message ? [message] : [])];
  return cliLaunchScript({ executable: "pi", label: "Pi", npmPackage: "@earendil-works/pi-coding-agent", version: VERSION, args });
}
