import type { PushSubscription } from "web-push";
import type { AgentRenderContext } from "./render-context.ts";

interface NotificationTurn {
  id: string;
  subscription?: PushSubscription;
  changed(): void;
}

// Only running turns have an entry. Removing one consumes its intent, so no
// separate finished flag or retained turn object can accidentally be re-armed.
const turns = new Map<string, NotificationTurn>();
function key(ctx: AgentRenderContext): string { return JSON.stringify([ctx.workspaceId, ctx.conversationId]); }

export function currentNotificationTurn(ctx: AgentRenderContext): { id: string; armed: boolean } | undefined {
  const turn = turns.get(key(ctx));
  return turn && { id: turn.id, armed: turn.subscription !== undefined };
}

export function startNotificationTurn(ctx: AgentRenderContext, changed: () => void): void {
  turns.set(key(ctx), { id: crypto.randomUUID(), changed });
}

export function setTurnNotification(ctx: AgentRenderContext, turnId: string, subscription: PushSubscription | undefined): boolean {
  const turn = turns.get(key(ctx));
  if (!turn || turn.id !== turnId) return false;
  turn.subscription = subscription;
  turn.changed();
  return true;
}

export function finishNotificationTurn(ctx: AgentRenderContext): PushSubscription | undefined {
  const turn = turns.get(key(ctx));
  turns.delete(key(ctx));
  return turn?.subscription;
}
