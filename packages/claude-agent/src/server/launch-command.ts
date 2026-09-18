import { parseModelRef } from "@atelier/llm/server";
import { cliLaunchScript, type CliModelSettings } from "@atelier/cli-agent/server";
import { shellQuote } from "@atelier/core";
import { workspaceRoot } from "@atelier/workspace";
import type { WorkspaceAgentInput } from "@atelier/shared";

/** Run inside tmux so installation progress and failures stay visible in the tab. */
export function claudeLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: CliModelSettings = {}): string {
  // Claude has no --image flag. Its Read tool opens the materialized images.
  const prompt = [input.text, ...input.attachmentNotes, ...imagePaths.map((path) => `Read the attached image at ${JSON.stringify(path)}.`)].filter(Boolean).join("\n\n");
  const args = ["--dangerously-skip-permissions", "--settings", JSON.stringify({ skipDangerousModePermissionPrompt: true }),
    ...(settings.model ? ["--model", parseModelRef(settings.model)!.id] : []),
    ...(settings.thinkingLevel ? ["--effort", settings.thinkingLevel] : []), ...(prompt ? ["--", prompt] : [])];
  // The subscription is already connected in Atelier. Preserve other CLI preferences.
  const configure = `const fs = require("node:fs");
const path = require("node:path").join(require("node:os").homedir(), ".claude.json");
const config = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
config.installMethod = "local";
config.autoUpdates = true;
config.hasCompletedOnboarding = true;
config.theme ??= "dark";
config.projects ??= {};
config.projects[${JSON.stringify(workspaceRoot)}] = { ...config.projects[${JSON.stringify(workspaceRoot)}], hasTrustDialogAccepted: true };
const temporary = path + ".atelier-" + process.pid;
fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
fs.renameSync(temporary, path);`;
  return cliLaunchScript({
    // Claude recognizes this path as npm-local and updates it in place. An arbitrary
    // npm prefix is detected as global, making updates target unwritable /usr/local.
    installDirectory: ".claude/local",
    executable: "claude", label: "Claude Code", npmPackage: "@anthropic-ai/claude-code", args,
    setup: `(
  flock 8
  node -e ${shellQuote(configure)}
) 8> "$HOME/.claude-config-setup.lock"`,
  });
}
