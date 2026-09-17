import { createCliModelSettings } from "@atelier/cli-agent/server";

export const codexModelSettings = createCliModelSettings({
  agentProvider: "codex", provider: "openai-codex", label: "Codex",
  effort: (level, mapped) => mapped === null ? undefined : mapped ?? (level === "off" ? "none" : level),
});
