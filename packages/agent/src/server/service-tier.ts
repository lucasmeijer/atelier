import { isJsonObject, type JsonObject, type JsonValue } from "@atelier/core";
import type { AgentServiceTier } from "@atelier/shared";
import type { ModelRuntime, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { getLastProviderServiceTier, setLastProviderServiceTier } from "./pi-config-models.ts";

export type { AgentServiceTier } from "@atelier/shared";

const fastModeProvider = "openai-codex";
const serviceTierEntryType = "atelier.service-tier";
type AgentServiceTierSource = JsonValue | FormDataEntryValue | undefined;

export function supportsFastMode(provider: string | undefined): boolean {
  return provider === fastModeProvider;
}

export function parseAgentServiceTier(value: AgentServiceTierSource): AgentServiceTier {
  return value === "priority" ? "priority" : "default";
}

export function serviceTierFromBranch(entries: SessionEntry[], provider: string): AgentServiceTier | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== serviceTierEntryType || !isJsonObject(entry.data)) continue;
    if (entry.data.provider === provider) return parseAgentServiceTier(entry.data.serviceTier);
  }
  return undefined;
}

export class AgentServiceTierState {
  private readonly values = new Map<string, AgentServiceTier>();

  constructor(private readonly sessionManager: SessionManager) {}

  async get(provider: string): Promise<AgentServiceTier> {
    const cached = this.values.get(provider);
    if (cached) return cached;
    const persisted = serviceTierFromBranch(this.sessionManager.getBranch(), provider);
    const serviceTier = persisted ?? await getLastProviderServiceTier(provider) ?? "default";
    this.values.set(provider, serviceTier);
    if (!persisted) this.sessionManager.appendCustomEntry(serviceTierEntryType, { provider, serviceTier });
    return serviceTier;
  }

  async set(provider: string, serviceTier: AgentServiceTier): Promise<void> {
    this.values.set(provider, serviceTier);
    this.sessionManager.appendCustomEntry(serviceTierEntryType, { provider, serviceTier });
  }

  reload(): void {
    this.values.clear();
  }
}

type RecordProviderServiceTier = (provider: string, serviceTier: AgentServiceTier) => Promise<void>;

export function modelRuntimeWithServiceTiers<Runtime extends Pick<ModelRuntime, "streamSimple">>(runtime: Runtime, state: Pick<AgentServiceTierState, "get">, recordProviderServiceTier: RecordProviderServiceTier = setLastProviderServiceTier): Runtime {
  const streamSimple: ModelRuntime["streamSimple"] = (model, context, options) => runtime.streamSimple(model, context, {
    ...options,
    onPayload: async (payload, requestModel) => {
      const transformed = await options?.onPayload?.(payload, requestModel) ?? payload;
      if (!supportsFastMode(model.provider) || !isJsonObject(transformed)) return transformed;
      const serviceTier = await state.get(model.provider);
      await recordProviderServiceTier(model.provider, serviceTier);
      return { ...transformed, service_tier: serviceTier };
    },
  });

  return new Proxy(runtime, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      // SAFETY: Proxy property keys are resolved against the wrapped runtime instance.
      return target[property as keyof Runtime];
    },
  });
}
