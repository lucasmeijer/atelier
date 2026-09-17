import { createCliModelSettings } from "@atelier/cli-agent/server";

export const claudeModelSettings = createCliModelSettings({
  agentProvider: "claude", provider: "anthropic", label: "Claude",
  effort: (level, mapped) => mapped !== null && ["low", "medium", "high", "xhigh", "max"].includes(mapped ?? level) ? mapped ?? level : undefined,
});
