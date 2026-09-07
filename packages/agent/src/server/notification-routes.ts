import { requestAcceptsJson } from "@atelier/core";
import { notificationControlTurboStream, notificationFeedbackId, notificationFrameId, renderNotificationControl, renderNotificationFeedback } from "./render-notification.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { turboStream, turboStreamResponse } from "./html.ts";
import { matchRoute, requireAgentRuntime, type AgentRouteHandler } from "./route-support.ts";
import { currentNotificationTurn, setTurnNotification } from "./turn-notifications.ts";
import { parsePushSubscription, pushPublicKey } from "./web-push.ts";

const intentSchema = Type.Object({ turnId: Type.String(), enabled: Type.Boolean(), subscription: Type.Optional(Type.Unknown()) });

export const handleNotificationRequest: AgentRouteHandler = async (request, url, options) => {
  if (url.pathname === "/agent-notifications/public-key" && request.method === "GET") {
    return Response.json({ publicKey: await pushPublicKey() });
  }
  const params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/notification$/);
  if (!params || !["GET", "POST"].includes(request.method)) return undefined;
  const ctx = { workspaceId: params[0], conversationId: params[1] };
  const runtime = await requireAgentRuntime(ctx.workspaceId, ctx.conversationId, options);
  const state = () => {
    const turn = currentNotificationTurn(ctx);
    return { turnId: turn?.id ?? null, busy: runtime.isStreaming, armed: turn?.armed ?? false };
  };
  if (request.method === "GET" && requestAcceptsJson(request)) return Response.json(state(), { headers: { "cache-control": "no-store" } });
  if (request.method === "GET") return new Response(`<turbo-frame id="${notificationFrameId(ctx)}">${renderNotificationControl(ctx, runtime.isStreaming)}</turbo-frame>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const reply = (message: string, status = 200): Response => requestAcceptsJson(request)
    ? Response.json(status < 400 ? { ...state(), message } : { error: { code: status === 409 ? "turn_ended" : "invalid_arguments", message } }, { status })
    : turboStreamResponse(notificationControlTurboStream(ctx, runtime.isStreaming)
      + turboStream("replace", notificationFeedbackId(ctx.workspaceId), renderNotificationFeedback(ctx.workspaceId, message, status >= 400)), { status });
  let input;
  let subscription;
  try {
    input = await request.json();
    if (!Value.Check(intentSchema, input)) return reply("Invalid notification request.", 422);
    subscription = input.enabled ? parsePushSubscription(input.subscription) : undefined;
  } catch (error) {
    return reply(error instanceof Error ? error.message : "Invalid notification request.", 422);
  }
  if (!runtime.isStreaming || !setTurnNotification(ctx, input.turnId, subscription)) return reply("That turn has already ended. No notification was scheduled.", 409);
  return reply(input.enabled ? "Notification set for this turn." : "Notification cancelled.");
};
