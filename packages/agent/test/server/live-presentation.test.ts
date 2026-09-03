import { expect, test } from "bun:test";
import { createSnapshotFirstLivePresentation, isFinalAssistantTextEvent } from "../../src/server/live-presentation.ts";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

test("live presentation delivers one snapshot before updates interleaved with its render", async () => {
  const firstSnapshotStarted = deferred();
  const releaseFirstSnapshot = deferred();
  const state = ["initial"];
  let attempts = 0;
  const presentation = createSnapshotFirstLivePresentation(() => {
    attempts += 1;
    const captured = state.join(",");
    firstSnapshotStarted.resolve();
    return async () => {
      await releaseFirstSnapshot.promise;
      return `snapshot:${captured}`;
    };
  });
  const deliveries: string[] = [];

  const subscribing = presentation.subscribe((html) => deliveries.push(html));
  await firstSnapshotStarted.promise;
  state.push("interleaved");
  presentation.publish("increment:interleaved");
  releaseFirstSnapshot.resolve();
  await subscribing.ready;

  expect(attempts).toBe(1);
  expect(deliveries).toEqual(["snapshot:initial", "increment:interleaved"]);
  presentation.publish("increment:later-1");
  presentation.publish("increment:later-2");
  expect(deliveries).toEqual([
    "snapshot:initial",
    "increment:interleaved",
    "increment:later-1",
    "increment:later-2",
  ]);

  subscribing.unsubscribe();
  presentation.publish("increment:after-unsubscribe");
  expect(deliveries.at(-1)).toBe("increment:later-2");
});

test("live presentation confirms while updates continue after its synchronous snapshot capture", async () => {
  let presentation!: ReturnType<typeof createSnapshotFirstLivePresentation>;
  let attempts = 0;
  const deliveries: string[] = [];
  presentation = createSnapshotFirstLivePresentation(() => {
    attempts += 1;
    const capturedAttempt = attempts;
    return async () => {
      presentation.publish(`increment:during-snapshot-${capturedAttempt}`);
      return `snapshot:${capturedAttempt}`;
    };
  });

  const subscription = presentation.subscribe((html) => deliveries.push(html));
  await subscription.ready;

  expect(attempts).toBe(1);
  expect(deliveries).toEqual([
    "snapshot:1",
    "increment:during-snapshot-1",
  ]);
  presentation.publish("increment:still-streaming");
  expect(deliveries.at(-1)).toBe("increment:still-streaming");
  subscription.unsubscribe();
});

test("cancelling a joining subscription releases its hung snapshot boundary immediately", async () => {
  const secondSnapshotStarted = deferred();
  const releaseSecondSnapshot = deferred();
  let captureCount = 0;
  const presentation = createSnapshotFirstLivePresentation(() => {
    const capture = ++captureCount;
    if (capture === 2) secondSnapshotStarted.resolve();
    return async () => {
      if (capture === 2) await releaseSecondSnapshot.promise;
      return `snapshot:${capture}`;
    };
  });
  const existing: string[] = [];
  const abandoned: string[] = [];
  const existingSubscription = presentation.subscribe((html) => existing.push(html));
  await existingSubscription.ready;

  const abandonedSubscription = presentation.subscribe((html) => abandoned.push(html));
  await secondSnapshotStarted.promise;
  abandonedSubscription.unsubscribe();
  await abandonedSubscription.ready;

  presentation.publish("increment:after-cancel");
  expect(existing).toEqual(["snapshot:1", "increment:after-cancel"]);
  expect(abandoned).toEqual([]);

  releaseSecondSnapshot.resolve();
  await Bun.sleep(0);
  expect(existing).toEqual(["snapshot:1", "increment:after-cancel"]);
  expect(abandoned).toEqual([]);
  existingSubscription.unsubscribe();
});

test("asynchronously rendered updates are delivered in invocation order", async () => {
  const releaseFirstUpdate = deferred();
  const state: string[] = [];
  const presentation = createSnapshotFirstLivePresentation(() => {
    const captured = state.join(",");
    return async () => `snapshot:${captured}`;
  });
  const liveDeliveries: string[] = [];
  const liveSubscription = presentation.subscribe((html) => liveDeliveries.push(html));
  await liveSubscription.ready;

  const first = presentation.publishRendered(async () => {
    await releaseFirstUpdate.promise;
    state.push("first");
    return "increment:first";
  });
  const second = presentation.publishRendered(async () => {
    state.push("second");
    return "increment:second";
  });
  const joiningDeliveries: string[] = [];
  const joining = presentation.subscribe((html) => joiningDeliveries.push(html));

  await second;
  expect(liveDeliveries).toEqual(["snapshot:"]);
  releaseFirstUpdate.resolve();
  await first;
  await joining.ready;

  expect(liveDeliveries).toEqual(["snapshot:", "increment:first", "increment:second"]);
  expect(joiningDeliveries).toEqual(["snapshot:second,first"]);
});

test("snapshot capture absorbs live changes queued behind an earlier rendered update", async () => {
  const releaseRenderedUpdate = deferred();
  const state: string[] = [];
  const presentation = createSnapshotFirstLivePresentation(() => {
    const captured = state.join(",");
    return async () => `snapshot:${captured}`;
  });

  const rendered = presentation.publishRendered(async () => {
    await releaseRenderedUpdate.promise;
    state.push("rendered");
    return "increment:rendered";
  });
  const deliveries: string[] = [];
  const subscribing = presentation.subscribe((html) => deliveries.push(html));
  state.push("live");
  presentation.publish("increment:live");
  presentation.publish("notice:ephemeral", { kind: "ephemeral" });

  releaseRenderedUpdate.resolve();
  await rendered;
  await subscribing.ready;

  expect(deliveries).toEqual(["snapshot:live,rendered", "notice:ephemeral"]);
  presentation.publish("increment:after-capture");
  expect(deliveries.at(-1)).toBe("increment:after-capture");
  subscribing.unsubscribe();
});

test("snapshot capture aligns existing subscribers and absorbs only pre-boundary paced text", async () => {
  const releaseRenderedUpdate = deferred();
  const releaseSnapshot = deferred();
  let state = "";
  let captureCount = 0;
  const presentation = createSnapshotFirstLivePresentation((alignExistingText) => {
    captureCount += 1;
    const captured = state;
    if (captured) alignExistingText(`aligned:${captured}`);
    return async () => {
      if (captureCount === 2) await releaseSnapshot.promise;
      return `snapshot:${captured}`;
    };
  });
  const existing: string[] = [];
  const joining: string[] = [];
  const existingSubscription = presentation.subscribe((html) => existing.push(html));
  await existingSubscription.ready;
  const rendered = presentation.publishRendered(async () => {
    await releaseRenderedUpdate.promise;
    return "rendered:predecessor";
  });
  const subscribing = presentation.subscribe((html) => joining.push(html));

  state = "before";
  presentation.publish("paced:before", { kind: "paced-text" });
  presentation.publish("notice:before", { kind: "ephemeral" });
  releaseRenderedUpdate.resolve();
  await rendered;
  await Bun.sleep(0);

  expect(existing).toEqual(["snapshot:", "rendered:predecessor", "aligned:before"]);

  state = "after";
  presentation.publish("paced:after", { kind: "paced-text" });
  releaseSnapshot.resolve();
  await subscribing.ready;

  expect(existing).toEqual(["snapshot:", "rendered:predecessor", "aligned:before", "notice:before", "paced:after"]);
  expect(joining).toEqual(["snapshot:before", "notice:before", "paced:after"]);
  subscribing.unsubscribe();
  existingSubscription.unsubscribe();
});

test("final-answer phase collapses Working at text start while commentary stays inside it", () => {
  const textEvent = (phase: "commentary" | "final_answer", stopReason = "pending") => ({
    type: "text_start" as const,
    contentIndex: 0,
    partial: {
      stopReason,
      content: [{ type: "text", text: "", textSignature: JSON.stringify({ v: 1, id: "message-1", phase }) }],
    },
  });

  expect(isFinalAssistantTextEvent(textEvent("final_answer"))).toBe(true);
  expect(isFinalAssistantTextEvent(textEvent("commentary", "stop"))).toBe(false);
  expect(isFinalAssistantTextEvent({ type: "text_delta", contentIndex: 0, delta: "Done", partial: { stopReason: "stop", content: [{ type: "text", text: "Done" }] } })).toBe(true);
});
