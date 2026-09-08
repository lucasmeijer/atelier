import { isJsonObject } from "@atelier/core";
import type { AgentModelRequestTransform } from "./delegation.ts";

/** Pi invokes conversion then payload preparation serially for each model request.
 * Only this host adapter installs Pi callbacks; the delegation adapter owns only its request-scoped transformation. */
export function attachModelRequestPipeline(session: any, createRequest: () => AgentModelRequestTransform): () => void {
  const convert = session.agent.convertToLlm;
  const previousPayload = session.agent.onPayload;
  let request: AgentModelRequestTransform | undefined;
  session.agent.convertToLlm = async (messages: any[]) => {
    request = createRequest();
    if (request.messages) messages = await request.messages(messages);
    return await convert(messages);
  };
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Provider payload is external input.
  session.agent.onPayload = async (input: unknown, model: { api: string }) => {
    const original = previousPayload ? await previousPayload(input, model) : input;
    const providerPayload = original ?? input;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the external SDK request object at its boundary before serialization.
    if (providerPayload === null || typeof providerPayload !== "object" || Array.isArray(providerPayload)) {
      throw new Error("Expected a provider request object.");
    }
    // Pi supplies SDK request objects, not JSON values: optional fields may be
    // undefined. Give delegation the wire representation its JsonObject contract
    // requires, using the same serialization semantics as the provider transport.
    const payload: unknown = JSON.parse(JSON.stringify(providerPayload));
    if (!isJsonObject(payload)) throw new Error("Expected a provider request object.");
    const transformed = request?.payload ? await request.payload(payload, model) : payload;
    await request?.prepared?.(model);
    return transformed;
  };
  return () => { session.agent.convertToLlm = convert; session.agent.onPayload = previousPayload; request = undefined; };
}
