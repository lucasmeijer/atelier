import { expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { currentNotificationTurn, finishNotificationTurn, setTurnNotification, startNotificationTurn } from "../../src/server/turn-notifications.ts";
import { parsePushSubscription } from "../../src/server/web-push.ts";

function subscription(endpoint = "https://web.push.apple.com/example") {
  const ecdh = createECDH("prime256v1");
  return { endpoint, keys: { p256dh: ecdh.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

const unchanged = () => {};

test("a notification belongs to one exact turn and is consumed once", () => {
  const ctx = { workspaceId: "notification-once", conversationId: "agent" };
  startNotificationTurn(ctx, unchanged);
  const { id } = currentNotificationTurn(ctx)!;
  const target = subscription();
  expect(setTurnNotification(ctx, "an-old-turn", target)).toBe(false);
  expect(currentNotificationTurn(ctx)!.armed).toBe(false);
  expect(setTurnNotification(ctx, id, target)).toBe(true);
  expect(currentNotificationTurn(ctx)!.armed).toBe(true);
  expect(finishNotificationTurn(ctx)).toEqual(target);
  expect(finishNotificationTurn(ctx)).toBeUndefined();
  expect(setTurnNotification(ctx, id, target)).toBe(false);
});

test("cancelling clears the intent without unsubscribing the browser", () => {
  const ctx = { workspaceId: "notification-cancel", conversationId: "agent" };
  let changes = 0;
  startNotificationTurn(ctx, () => { changes += 1; });
  const { id } = currentNotificationTurn(ctx)!;
  setTurnNotification(ctx, id, subscription());
  expect(setTurnNotification(ctx, id, undefined)).toBe(true);
  expect(currentNotificationTurn(ctx)!.armed).toBe(false);
  expect(finishNotificationTurn(ctx)).toBeUndefined();
  expect(changes).toBe(2);
});

test("repeat arming replaces the destination instead of sending duplicate notifications", () => {
  const ctx = { workspaceId: "notification-replace", conversationId: "agent" };
  startNotificationTurn(ctx, unchanged);
  const { id } = currentNotificationTurn(ctx)!;
  const second = subscription();
  setTurnNotification(ctx, id, subscription());
  setTurnNotification(ctx, id, second);
  expect(finishNotificationTurn(ctx)).toEqual(second);
});

test("turns are isolated by workspace and conversation and never carry into a later turn", () => {
  const a = { workspaceId: "notification-a", conversationId: "agent" };
  const b = { workspaceId: "notification-b", conversationId: "agent" };
  const c = { workspaceId: "notification-a", conversationId: "other-agent" };
  for (const ctx of [a, b, c]) startNotificationTurn(ctx, unchanged);
  const previous = currentNotificationTurn(a)!;
  setTurnNotification(a, previous.id, subscription());
  expect(currentNotificationTurn(b)!.armed).toBe(false);
  expect(currentNotificationTurn(c)!.armed).toBe(false);
  expect(finishNotificationTurn(a)).toBeDefined();
  expect(currentNotificationTurn(a)).toBeUndefined();
  startNotificationTurn(a, unchanged);
  expect(setTurnNotification(a, previous.id, subscription())).toBe(false);
  expect(currentNotificationTurn(a)!.armed).toBe(false);
  for (const ctx of [a, b, c]) finishNotificationTurn(ctx);
});

test("subscriptions accept native browser push services", () => {
  for (const endpoint of ["https://web.push.apple.com/token", "https://fcm.googleapis.com/fcm/send/token", "https://updates.push.services.mozilla.com/wpush/v2/token", "https://wns2-par02p.notify.windows.com/token"]) {
    const input = subscription(endpoint);
    expect(parsePushSubscription(input)).toEqual(input);
  }
});

test("subscriptions cannot target arbitrary servers, credentials or alternate ports", () => {
  for (const endpoint of ["http://web.push.apple.com/token", "https://localhost/token", "https://127.0.0.1/token", "https://example.com/token", "https://web.push.apple.com.attacker.example/token", "https://user@web.push.apple.com/token", "https://web.push.apple.com:8443/token"]) {
    expect(() => parsePushSubscription(subscription(endpoint))).toThrow();
  }
});

test("malformed subscriptions and keys are rejected at the browser input boundary", () => {
  for (const value of [null, {}, { endpoint: "not a URL", keys: {} }, { ...subscription(), keys: { p256dh: "bad", auth: "bad" } }]) {
    expect(() => parsePushSubscription(value)).toThrow();
  }
});
