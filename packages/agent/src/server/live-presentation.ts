import { assistantTextPhase } from "./transcript.ts";
import type { AgentLivePresentationListener, AgentLivePresentationSubscription } from "./runtime-types.ts";

interface AssistantTextEventView {
  type: "text_start" | "text_delta";
  contentIndex: number;
  delta?: string;
  partial: {
    stopReason?: string;
    content?: Array<{ type: string; text?: string; textSignature?: string }>;
  };
}

/** True at the earliest Pi event that identifies streamed text as the final answer. */
export function isFinalAssistantTextEvent(event: AssistantTextEventView): boolean {
  const partial = event.partial;
  const part = partial.content?.[event.contentIndex];
  if (part?.type !== "text") return false;
  const phase = assistantTextPhase(part.textSignature);
  if (phase !== undefined) return phase === "final_answer";
  return partial.stopReason === "stop" || partial.stopReason === "length" || partial.stopReason === "deferred";
}

type LivePresentationSubscriber = {
  active: boolean;
  live: boolean;
  listener: AgentLivePresentationListener;
  absorbedLiveThrough?: number;
  absorbedTextThrough?: number;
};

type LivePresentationChange = {
  complete: boolean;
  kind: "live" | "text" | "ephemeral" | "rendered" | "snapshot";
  resolveDelivered(): void;
  html?: string;
  subscriber?: LivePresentationSubscriber;
};

interface BegunLivePresentationChange {
  sequence: number;
  predecessors: Promise<void>;
  delivered: Promise<void>;
}

interface SnapshotFirstLivePresentation {
  subscribe(listener: AgentLivePresentationListener): AgentLivePresentationSubscription;
  publish(streamHtml?: string, options?: { kind?: "snapshot-represented" | "paced-text" | "ephemeral" }): void;
  publishRendered(render: () => Promise<string>): Promise<void>;
}

/**
 * Serializes the authoritative-update-to-live-update handoff behind one subscription interface.
 * A subscription reserves one ordered snapshot boundary. Its capture function must synchronously
 * freeze all mutable presentation state before returning an async completion function. Live
 * changes absorbed before that capture are skipped for the joining subscriber; later changes are
 * buffered and delivered after its snapshot. Rendered changes retain invocation order globally.
 */
export function createSnapshotFirstLivePresentation(captureAuthoritativeUpdate: (publishToExisting: (html: string) => void) => () => Promise<string>): SnapshotFirstLivePresentation {
  const subscribers = new Set<LivePresentationSubscriber>();
  const changes = new Map<number, LivePresentationChange>();
  let nextChange = 0;
  let nextDelivery = 0;
  let deliveredTail = Promise.resolve();

  function unsubscribe(subscriber: LivePresentationSubscriber): void {
    subscriber.active = false;
    subscribers.delete(subscriber);
  }

  function beginChange(kind: LivePresentationChange["kind"], subscriber?: LivePresentationSubscriber): BegunLivePresentationChange {
    const sequence = nextChange++;
    const predecessors = deliveredTail;
    let resolveDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivered = resolve;
    });
    deliveredTail = delivered;
    changes.set(sequence, { complete: false, kind, resolveDelivered, subscriber });
    return { sequence, predecessors, delivered };
  }

  function completeChange(sequence: number, html?: string): void {
    const change = changes.get(sequence)!;
    change.complete = true;
    change.html = html;
    while (changes.get(nextDelivery)?.complete) {
      const sequenceToDeliver = nextDelivery++;
      const delivery = changes.get(sequenceToDeliver)!;
      changes.delete(sequenceToDeliver);
      if (delivery.subscriber) {
        if (delivery.subscriber.active) {
          delivery.subscriber.live = true;
          delivery.subscriber.listener(delivery.html ?? "");
        }
      } else if (delivery.html) {
        for (const subscriber of subscribers) {
          const absorbed = (delivery.kind === "live" && sequenceToDeliver <= (subscriber.absorbedLiveThrough ?? -1))
            || (delivery.kind === "text" && sequenceToDeliver <= Math.max(subscriber.absorbedLiveThrough ?? -1, subscriber.absorbedTextThrough ?? -1));
          if (subscriber.live && !absorbed) subscriber.listener(delivery.html);
        }
      }
      delivery.resolveDelivered();
    }
  }

  async function publishRendered(render: () => Promise<string>): Promise<void> {
    const { sequence } = beginChange("rendered");
    let html: string;
    try {
      html = await render();
    } catch (error) {
      completeChange(sequence);
      throw error;
    }
    completeChange(sequence, html);
  }

  return {
    subscribe(listener) {
      const subscriber: LivePresentationSubscriber = { active: true, live: false, listener };
      subscribers.add(subscriber);
      const { sequence, predecessors, delivered } = beginChange("snapshot", subscriber);
      let changeCompleted = false;
      let resolveCancelled!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        resolveCancelled = resolve;
      });
      const completeSubscriptionChange = (html?: string): void => {
        if (changeCompleted) return;
        changeCompleted = true;
        completeChange(sequence, html);
      };
      const unsubscribeSubscription = (): void => {
        if (!subscriber.active) return;
        unsubscribe(subscriber);
        completeSubscriptionChange();
        resolveCancelled();
      };
      const ready = (async () => {
        let snapshot: string | undefined;
        try {
          await Promise.race([predecessors, cancelled]);
          if (!subscriber.active) return;
          const completeSnapshot = captureAuthoritativeUpdate((html) => {
            const absorbedTextThrough = nextChange - 1;
            for (const existing of subscribers) {
              if (existing === subscriber || !existing.live) continue;
              existing.listener(html);
              existing.absorbedTextThrough = Math.max(existing.absorbedTextThrough ?? -1, absorbedTextThrough);
            }
          });
          subscriber.absorbedLiveThrough = nextChange - 1;
          subscriber.absorbedTextThrough = subscriber.absorbedLiveThrough;
          const result = await Promise.race([
            completeSnapshot().then((html) => ({ cancelled: false as const, html })),
            cancelled.then(() => ({ cancelled: true as const })),
          ]);
          if (result.cancelled || !subscriber.active) return;
          snapshot = result.html;
        } catch (error) {
          unsubscribe(subscriber);
          completeSubscriptionChange();
          throw error;
        }
        completeSubscriptionChange(snapshot);
        await Promise.race([delivered, cancelled]);
      })();
      return { ready, unsubscribe: unsubscribeSubscription };
    },

    publish(streamHtml, options) {
      const kind = options?.kind === "ephemeral"
        ? "ephemeral"
        : options?.kind === "paced-text"
          ? "text"
          : "live";
      const { sequence } = beginChange(kind);
      completeChange(sequence, streamHtml);
    },

    publishRendered,
  };
}

