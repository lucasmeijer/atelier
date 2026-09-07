import { buttonHtml } from "@atelier/design-system/button";
import { Icons } from "@atelier/design-system/icons";
import { domId, escapeHtml, turboStream } from "./html.ts";
import { agentPath, type AgentRenderContext } from "./render-context.ts";
import { currentNotificationTurn } from "./turn-notifications.ts";

export function notificationControlId(ctx: AgentRenderContext): string { return domId("agent_notification", ctx.workspaceId, ctx.conversationId); }
export function notificationFrameId(ctx: AgentRenderContext): string { return `${notificationControlId(ctx)}_frame`; }
export function notificationFeedbackId(workspaceId: string): string { return domId("agent_notification_feedback", workspaceId); }

export function renderNotificationHeader(workspaceId: string, conversations: readonly { id: string }[]): string {
  const frames = conversations.map(({ id: conversationId }) => {
    const ctx = { workspaceId, conversationId };
    return `<span hidden data-notification-conversation="${escapeHtml(conversationId)}"><turbo-frame id="${notificationFrameId(ctx)}" src="${escapeHtml(agentPath(ctx, "/notification"))}"></turbo-frame></span>`;
  }).join("");
  return `<span data-controller="agent-notifications" data-action="atelier:workspace-agent-selected@window->agent-notifications#select">${renderNotificationFeedback(workspaceId)}${frames}</span>`;
}

/** One dismissible surface for browser errors and server acknowledgements. */
export function renderNotificationFeedback(workspaceId: string, message = "", error = false): string {
  return `<span id="${notificationFeedbackId(workspaceId)}" class="agent-noticeline agent-notification-feedback"${message ? "" : " hidden"} data-agent-notifications-target="feedback"><span role="${error ? "alert" : "status"}" data-agent-notifications-target="message">${escapeHtml(message)}</span>${buttonHtml({
    type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss notification message" },
    attributesHtml: 'data-action="click->agent-notifications#dismiss"',
  })}</span>`;
}

export function renderNotificationControl(ctx: AgentRenderContext, busy: boolean): string {
  const turn = currentNotificationTurn(ctx);
  const armed = busy && (turn?.armed ?? false);
  const label = !busy ? "Notifications are available while the agent is working" : armed ? "Cancel notification for this turn" : "Notify when this turn finishes";
  return `<span id="${notificationControlId(ctx)}">${buttonHtml({
    type: "button", variant: armed ? "primary" : "secondary", disabled: !busy || !turn,
    content: { kind: "icon-only", iconHtml: Icons.Bell, label },
    attributesHtml: `aria-pressed="${armed}" data-action="click->agent-notifications#toggle" data-notification-url="${escapeHtml(agentPath(ctx, "/notification"))}" data-notification-turn="${turn?.id ?? ""}" data-notification-armed="${armed}"`,
  })}</span>`;
}

export function notificationControlTurboStream(ctx: AgentRenderContext, busy: boolean): string {
  return turboStream("replace", notificationControlId(ctx), renderNotificationControl(ctx, busy));
}
