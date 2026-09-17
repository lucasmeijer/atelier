import { AtelierCoreError, createKeyedOperationQueue } from "@atelier/core";
import type { WorkspaceAgentTabProvider } from "@atelier/shared";

/** Shell policy, independent of the occupant's session format and shutdown behavior. */
export function createAgentPaneHost(tabs: WorkspaceAgentTabProvider, prepareDefault: (workspaceId: string) => Promise<void>): WorkspaceAgentTabProvider {
  const serialize = createKeyedOperationQueue();
  return {
    render: (context) => tabs.render(context),
    renderHeader: tabs.renderHeader?.bind(tabs),
    list: ({ workspaceId }) => serialize(workspaceId, async () => {
      try {
        const conversations = await tabs.list({ workspaceId });
        if (conversations.length) return conversations;
        await prepareDefault(workspaceId);
        return await tabs.list({ workspaceId });
      } catch (error) {
        if (error instanceof AtelierCoreError && error.code === "workspace_not_found") return [];
        throw error;
      }
    }),
    close: (context) => serialize(context.workspaceId, async () => {
      const conversations = await tabs.list(context);
      if (!conversations.some((conversation) => conversation.id === context.conversationId)) {
        throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${context.conversationId}`);
      }
      if (conversations.length === 1) throw new AtelierCoreError("last_agent_conversation", "The last Agent conversation cannot be closed");
      await tabs.close(context);
    }),
  };
}
