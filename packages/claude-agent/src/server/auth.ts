import { AtelierCoreError } from "@atelier/core";
import { createPiModelRuntime } from "@atelier/llm/server";

export const claudeSubscriptionSetupUrl = "/settings/models/step?provider=anthropic";

export async function requireClaudeSubscription(): Promise<void> {
  const credentials = await (await createPiModelRuntime()).listCredentials();
  if (!credentials.some((credential) => credential.providerId === "anthropic" && credential.type === "oauth")) {
    throw new AtelierCoreError("agent_setup_required", "Connect a Claude subscription before creating a Claude agent.", { setupUrl: claudeSubscriptionSetupUrl });
  }
}
