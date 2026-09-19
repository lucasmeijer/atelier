import { ModelsError } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderConnection } from "./provider-connections.ts";

interface ProviderAvailability {
  modelIds: ReadonlySet<string>;
  connection: ProviderConnection;
}

/** Resolve each provider independently; rejected OAuth must not hide other providers. */
export async function providerAvailability(runtime: Pick<ModelRuntime, "getAvailable" | "checkAuth">, providers: readonly string[]) {
  return new Map<string, ProviderAvailability>(await Promise.all([...new Set(providers)].map(async (provider) => {
    try {
      const models = await runtime.getAvailable(provider);
      const connection = await runtime.checkAuth(provider) ? "connected" : "disconnected";
      return [provider, { modelIds: new Set(models.map((model) => model.id)), connection }] as const;
    } catch (error) {
      if (!(error instanceof ModelsError) || error.code !== "oauth") throw error;
      return [provider, { modelIds: new Set<string>(), connection: "needs_attention" }] as const;
    }
  })));
}
