/// <reference lib="dom" />

import { decodeCableServerMessage, serializeCableIdentifier, type AtelierCableClient, type CableClientMessage, type CableIdentifier, type CableSubscription, type CableSubscriptionOptions, type WorkspaceVisibilityReport } from "@atelier/shared";

declare global {
  interface Window {
    AtelierCable?: AtelierCableClient;
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

type SubscriptionLease = CableSubscription & {
  options?: CableSubscriptionOptions;
};

type DesiredSubscription = {
  identifier: CableIdentifier;
  leases: Set<SubscriptionLease>;
  ready: boolean;
  subscriptionId?: string;
};

export type CableStreamRenderer = (html: string, isCurrent: () => boolean, onApplied: () => void) => void;

export function createAtelierCableClient(renderStreams: CableStreamRenderer): AtelierCableClient {
  const desired = new Map<string, DesiredSubscription>();
  const delays = [100, 250, 500, 1000, 2000, 5000];
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let recovering = true;
  let closingForPageHide = false;
  let visibility: WorkspaceVisibilityReport = { surfaceKeys: [] };
  let lastMessageAt = Date.now();
  setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 75_000) socket.close();
  }, 15_000);

  function cableUrl(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/cable`;
  }

  function changed(): void { document.dispatchEvent(new Event("live:connection")); }

  function sendRaw(message: CableClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function subscribeOnWire(subscription: DesiredSubscription): void {
    const subscriptionId = crypto.randomUUID();
    subscription.ready = false;
    subscription.subscriptionId = subscriptionId;
    changed();
    sendRaw({ command: "subscribe", identifier: subscription.identifier, subscriptionId });
  }

  function resubscribeAll(): void {
    for (const subscription of desired.values()) subscribeOnWire(subscription);
  }

  function scheduleReconnect(): void {
    if (closingForPageHide || reconnectTimer) return;
    const delay = delays[Math.min(attempts++, delays.length - 1)]!;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function matchingSubscription(identifier: CableIdentifier, subscriptionId: string): DesiredSubscription | undefined {
    const subscription = desired.get(serializeCableIdentifier(identifier));
    return subscription?.subscriptionId === subscriptionId ? subscription : undefined;
  }

  function markSubscriptionsDisconnected(notify: boolean): void {
    for (const subscription of desired.values()) {
      if (notify && subscription.ready) {
        for (const lease of subscription.leases) lease.options?.onDisconnected?.();
      }
      subscription.ready = false;
      subscription.subscriptionId = undefined;
    }
  }

  function handleMessage(source: WebSocket, event: MessageEvent): void {
    if (socket !== source) return;
    lastMessageAt = Date.now();
    const message = decodeCableServerMessage(String(event.data));
    switch (message.type) {
      case "welcome":
        attempts = 0;
        sendRaw({ command: "visibility", visibility });
        resubscribeAll();
        break;
      case "confirm_subscription": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (!subscription) break;
        const isCurrent = () => matchingSubscription(message.identifier, message.subscriptionId) === subscription;
        const applied = () => {
          if (!isCurrent()) return;
          subscription.ready = true;
          if ([...desired.values()].every(item => item.ready)) recovering = false;
          changed();
          for (const lease of subscription.leases) lease.options?.onReady?.();
        };
        if (message.html) renderStreams(message.html, isCurrent, applied);
        else applied();
        break;
      }
      case "reject_subscription":
        const rejected = matchingSubscription(message.identifier, message.subscriptionId);
        if (rejected) {
          console.error("Cable subscription rejected", message);
          for (const lease of rejected.leases) lease.options?.onRejected?.(message.reason);
        }
        break;
      case "turbo_stream": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (subscription) renderStreams(message.html, () => matchingSubscription(message.identifier, message.subscriptionId) === subscription, () => {});
        break;
      }
      case "ping":
        sendRaw({ command: "pong", time: message.time });
        break;
      case "error":
        console.error("Cable error", message.message);
        break;
    }
  }

  function connect(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    lastMessageAt = Date.now();
    const connecting = new WebSocket(cableUrl());
    socket = connecting;
    connecting.onmessage = (event) => handleMessage(connecting, event);
    connecting.onclose = () => {
      if (socket !== connecting) return;
      socket = undefined;
      recovering = true;
      if (!closingForPageHide) markSubscriptionsDisconnected(true);
      changed();
      scheduleReconnect();
    };
    connecting.onerror = () => connecting.close();
  }

  window.addEventListener("pagehide", () => {
    closingForPageHide = true;
    recovering = true;
    markSubscriptionsDisconnected(false);
    socket?.close();
  });
  window.addEventListener("pageshow", () => {
    closingForPageHide = false;
    if (desired.size > 0) connect();
  });

  const client: AtelierCableClient = {
    ready() { return socket?.readyState === WebSocket.OPEN && !recovering; },
    reconnect() { socket?.close(); },
    reportVisibility(next) {
      visibility = next;
      sendRaw({ command: "visibility", visibility });
    },
    subscribe(identifier, options) {
      const key = serializeCableIdentifier(identifier);
      let subscription = desired.get(key);
      if (!subscription) {
        subscription = { identifier, leases: new Set(), ready: false };
        desired.set(key, subscription);
        closingForPageHide = false;
        connect();
        if (socket?.readyState === WebSocket.OPEN) subscribeOnWire(subscription);
      }

      const lease: SubscriptionLease = {
        options,
        unsubscribe() {
          if (!subscription.leases.delete(lease) || subscription.leases.size > 0) return;
          if (desired.get(key) !== subscription) return;
          desired.delete(key);
          if ([...desired.values()].every(item => item.ready)) recovering = false;
          changed();
          if (subscription.subscriptionId) {
            sendRaw({ command: "unsubscribe", identifier: subscription.identifier, subscriptionId: subscription.subscriptionId });
          }
        },
      };
      subscription.leases.add(lease);
      if (subscription.ready) requestAnimationFrame(() => {
        if (subscription.leases.has(lease) && desired.get(key) === subscription && subscription.ready) lease.options?.onReady?.();
      });
      return lease;
    },
  };

  return client;
}
