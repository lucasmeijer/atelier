import { AtelierCoreError, readJsonObject, requestAcceptsJson } from "@atelier/core";
import { turboStreamResponse } from "./html.ts";
import { parseModelRef } from "./model-state.ts";
import { setModelThinkingLevel } from "./pi-config-models.ts";
import { invalidateAgentView, matchRoute, requireAgentRuntime, type AgentRouteHandler } from "./route-support.ts";
import { parseAgentServiceTier } from "./service-tier.ts";

export const handleConfigurationRequest: AgentRouteHandler = async (request, url, options) => {
  let params: string[] | undefined;
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/model$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).model : (await request.formData()).get("model");
    const model = parseModelRef(String(value ?? ""));
    if (!model) {
      if (json) throw new AtelierCoreError("invalid_arguments", "valid model is required");
      return turboStreamResponse("");
    }
    const runtime = await requireAgentRuntime(params[0], params[1], options);
    await runtime.setModel(model.provider, model.id);
    await invalidateAgentView(options, params[0], params[1]);
    return json ? Response.json({ agent: { conversationId: params[1], model: `${model.provider}::${model.id}` } }) : turboStreamResponse("");
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/service-tier$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).serviceTier : (await request.formData()).get("serviceTier");
    const serviceTier = parseAgentServiceTier(value);
    const runtime = await requireAgentRuntime(params[0], params[1], options);
    await runtime.setServiceTier(serviceTier);
    await invalidateAgentView(options, params[0], params[1]);
    return json ? Response.json({ agent: { conversationId: params[1], serviceTier } }) : turboStreamResponse("");
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/thinking$/)) && request.method === "POST") {
    const json = requestAcceptsJson(request);
    const value = json ? (await readJsonObject(request)).level : (await request.formData()).get("level");
    const level = String(value ?? "");
    if (!level) {
      if (json) throw new AtelierCoreError("invalid_arguments", "level is required");
      return turboStreamResponse("");
    }
    const runtime = await requireAgentRuntime(params[0], params[1], options);
    await runtime.setThinkingLevel(level);
    const model = runtime.currentModel();
    if (model) await setModelThinkingLevel(model.provider, model.id, level);
    await invalidateAgentView(options, params[0], params[1]);
    return json ? Response.json({ agent: { conversationId: params[1], thinkingLevel: level } }) : turboStreamResponse("");
  }
  return undefined;
};
