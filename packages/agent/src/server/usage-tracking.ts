import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getUsageLedger, type UsageLedger } from "./usage-ledger.ts";

/** Both consumers (streaming turns and result-only summaries) record a response exactly once. */
export function trackUsageStream(source: AssistantMessageEventStream, record: (message: AssistantMessage) => void): AssistantMessageEventStream {
  let recorded = false;
  const recordOnce = (message: AssistantMessage) => {
    if (recorded) return;
    record(message);
    recorded = true;
  };
  return new Proxy(source, {
    get(target, property) {
      if (property === "result") return async () => {
        const message = await target.result();
        recordOnce(message);
        return message;
      };
      if (property === Symbol.asyncIterator) return async function* () {
        for await (const event of target) {
          if (event.type === "done") recordOnce(event.message);
          if (event.type === "error") recordOnce(event.error);
          yield event;
        }
      };
      // SAFETY: All remaining members are forwarded from the wrapped Pi stream.
      return target[property as keyof AssistantMessageEventStream];
    },
  });
}

export function modelRuntimeWithUsageTracking<Runtime extends Pick<ModelRuntime, "streamSimple">>(runtime: Runtime, ledger: Pick<UsageLedger, "record"> = getUsageLedger()): Runtime {
  const streamSimple: ModelRuntime["streamSimple"] = (model, context, options) => trackUsageStream(runtime.streamSimple(model, context, options), (message) => {
    // Partial usage reported on aborted/failed attempts counts too. Copied history never passes here.
    ledger.record(message.provider, message.model, message.usage);
  });
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      // SAFETY: All other runtime members retain the wrapped runtime's implementation.
      return target[property as keyof Runtime];
    },
  });
}
