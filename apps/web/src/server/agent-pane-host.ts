import { AtelierCoreError, createKeyedOperationQueue } from "@atelier/core";
import type { WorkspaceAgentProvider, WorkspaceAgentTabSummary } from "@atelier/shared";

export interface HostedAgentTab extends WorkspaceAgentTabSummary {
  providerId: string;
  iconHtml: string;
}

/** The host routes globally unique conversation identities without interpreting provider storage. */
export function createAgentPaneHost(providers: readonly WorkspaceAgentProvider[]) {
  const serialize = createKeyedOperationQueue();
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  if (byId.size !== providers.length) throw new Error("Duplicate agent provider identity");

  async function list(context: { workspaceId: string }): Promise<HostedAgentTab[]> {
    const tabs = (await Promise.all(providers.map(async (provider) =>
      (await provider.tabs.list(context)).map((tab) => ({ ...tab, providerId: provider.id, iconHtml: provider.iconHtml })),
    ))).flat();
    if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) throw new Error("Duplicate agent conversation identity");
    return tabs;
  }

  async function owner(context: { workspaceId: string; conversationId: string }) {
    const tab = (await list(context)).find((tab) => tab.id === context.conversationId);
    if (!tab) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${context.conversationId}`);
    return byId.get(tab.providerId)!;
  }

  return {
    list,
    async render(context: { workspaceId: string; conversationId: string }) {
      return (await owner(context)).tabs.render(context);
    },
    close(context: { workspaceId: string; conversationId: string }) {
      return serialize(context.workspaceId, async () => (await owner(context)).tabs.close(context));
    },
  };
}
