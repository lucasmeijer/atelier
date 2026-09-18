import { shellQuote } from "@atelier/core";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "@atelier/llm/server";
import { cliLaunchScript, type CliModelSettings } from "@atelier/cli-agent/server";
import type { WorkspaceAgentInput } from "@atelier/shared";

/** Pin the CLI to Atelier's Pi runtime so auth formats and model capabilities agree. */
export function piLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings = {}, turnFinishedCommand?: string): string {
  const prompt = [input.text, ...input.attachmentNotes].filter(Boolean).join("\n\n");
  const model = settings.model ? parseModelRef(settings.model)! : undefined;
  // Pi treats @-prefixed positionals as file attachments even after --.
  const message = prompt.startsWith("@") ? `\n${prompt}` : prompt;
  const args = ["--approve", "--offline", "--tui-mode", "regular", "--session-dir", "/home/atelier/.local/share/pi/sessions",
    ...(turnFinishedCommand ? ["--extension", `${turnFinishedCommand}.ts`] : []),
    ...(model ? ["--provider", model.provider, "--model", model.id] : []),
    ...(settings.thinkingLevel ? ["--thinking", settings.thinkingLevel] : []),
    "--", ...imagePaths.map((path) => `@${path}`), ...(message ? [message] : [])];
  let setup: string | undefined;
  if (turnFinishedCommand) {
    const extension = `export default function (pi) {
  pi.on("agent_end", async () => {
    const result = await pi.exec("sh", [${JSON.stringify(turnFinishedCommand)}]);
    if (result.code !== 0) throw new Error(result.stderr);
  });
}`;
    setup = `umask 077; printf '%s' ${shellQuote(extension)} > ${shellQuote(`${turnFinishedCommand}.ts`)}`;
  }
  return cliLaunchScript({ executable: "pi", label: "Pi", npmPackage: "@earendil-works/pi-coding-agent", version: VERSION, args, setup });
}
