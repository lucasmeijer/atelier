import { AtelierCoreError } from "@atelier/core";
import { hasAvailableConfiguredModel } from "@atelier/llm/server";

export function piModelSetupRequired(): AtelierCoreError {
  return new AtelierCoreError("agent_setup_required", "Connect a provider and choose an available favorite model before creating a Pi agent.", { setupUrl: "/settings?section=models" });
}

export async function requirePiModels(): Promise<void> {
  if (!await hasAvailableConfiguredModel()) throw piModelSetupRequired();
}
