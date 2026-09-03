/// <reference lib="dom" />

import { decodeCableServerMessage, serializeCableIdentifier, type AtelierCableClient, type CableClientMessage, type CableIdentifier, type CableSubscription, type CableSubscriptionOptions } from "@atelier/shared";

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

export function createAtelierCableClient(): AtelierCableClient {
  const desired = new Map<string, DesiredSubscription>();
  const delays = [100, 250, 500, 1000, 2000, 5000];
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let closingForPageHide = false;
  let activeConnectionId: string | undefined;

  function cableUrl(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/cable`;
  }

  function sendRaw(message: CableClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function subscribeOnWire(subscription: DesiredSubscription): void {
    const subscriptionId = crypto.randomUUID();
    subscription.ready = false;
    subscription.subscriptionId = subscriptionId;
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
    const message = decodeCableServerMessage(String(event.data));
    switch (message.type) {
      case "welcome":
        attempts = 0;
        activeConnectionId = message.connectionId;
        resubscribeAll();
        break;
      case "confirm_subscription": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (!subscription) break;
        if (message.html) window.Turbo?.renderStreamMessage(message.html);
        requestAnimationFrame(() => {
          if (matchingSubscription(message.identifier, message.subscriptionId) !== subscription) return;
          subscription.ready = true;
          for (const lease of subscription.leases) lease.options?.onReady?.();
        });
        break;
      }
      case "reject_subscription":
        if (matchingSubscription(message.identifier, message.subscriptionId)) console.error("Cable subscription rejected", message);
        break;
      case "turbo_stream":
        if (matchingSubscription(message.identifier, message.subscriptionId)) window.Turbo?.renderStreamMessage(message.html);
        break;
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
    const connecting = new WebSocket(cableUrl());
    socket = connecting;
    connecting.onmessage = (event) => handleMessage(connecting, event);
    connecting.onclose = () => {
      if (socket !== connecting) return;
      socket = undefined;
      activeConnectionId = undefined;
      if (!closingForPageHide) markSubscriptionsDisconnected(true);
      scheduleReconnect();
    };
    connecting.onerror = () => connecting.close();
  }

  window.addEventListener("pagehide", () => {
    closingForPageHide = true;
    markSubscriptionsDisconnected(false);
    socket?.close();
  });
  window.addEventListener("pageshow", () => {
    closingForPageHide = false;
    if (desired.size > 0) connect();
  });

  const client: AtelierCableClient = {
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
    connected() {
      return socket?.readyState === WebSocket.OPEN;
    },
    connectionId() {
      return activeConnectionId;
    },
  };

  return client;
}
