import type { AtelierEventBus } from "@atelier/core";
import type { AgentPaneState } from "./render-composer.ts";
import type { AgentServiceTier } from "./service-tier.ts";
import type { TreeFilterMode } from "./session-tree.ts";
import type { ImageRef } from "./transcript.ts";

export type AgentLivePresentationListener = (streamHtml: string) => void;

export interface AgentLivePresentationSubscription {
  /** Resolves after the authoritative snapshot has been delivered, or after cancellation. */
  readonly ready: Promise<void>;
  /** Immediately removes the subscriber, including while its snapshot is still rendering. */
  unsubscribe(): void;
}

export interface SubmitOptions {
  images?: ImageRef[];
  /** Extra lines appended to the prompt describing non-image attachments. */
  attachmentNotes?: string[];
}

export type RewindMode = "discard" | "summary";

export interface WorkspaceAgentRuntimeOptions {
  events?: AtelierEventBus;
}

export interface WorkspaceAgentRuntime {
  workspaceId: string;
  conversationId: string;
  label: string;
  sessionFile: string;
  readonly isStreaming: boolean;
  /** First delivers one complete authoritative update, then every incremental update in order. */
  subscribeLivePresentation(listener: AgentLivePresentationListener): AgentLivePresentationSubscription;
  /** Server-rendered state for initial pane HTML. */
  paneState(revealTarget?: string): Promise<AgentPaneState>;
  userMessages(): string[];
  submit(text: string, options?: SubmitOptions): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  currentModel(): { provider: string; id: string } | undefined;
  currentThinkingLevel(): string;
  availableThinkingLevels(): string[];
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setServiceTier(serviceTier: AgentServiceTier): Promise<void>;
  rewind(entryId: string, mode: RewindMode, customInstructions?: string): Promise<void>;
  treeHtml(options: { filter: TreeFilterMode; query: string }): string;
  labelTreeEntry(entryId: string, label: string, operation: "add" | "remove"): void;
  navigateTree(entryId: string, options: { summarize: boolean; customInstructions?: string }): Promise<string>;
  newSession(): Promise<void>;
  detailHtml(key: string, count?: number): Promise<string>;
}
