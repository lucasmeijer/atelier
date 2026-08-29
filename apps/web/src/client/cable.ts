/// <reference lib="dom" />

import { decodeCableServerMessage, serializeCableIdentifier, type AtelierCableClient, type CableClientMessage, type CableIdentifier } from "@atelier/shared";

declare global {
  interface Window {
    AtelierCable?: AtelierCableClient;
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

export function createAtelierCableClient(): AtelierCableClient {
  const desired = new Map<string, { identifier: CableIdentifier; ready: boolean; onReady?: () => void; onDisconnected?: () => void }>();
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

  function resubscribeAll(): void {
    for (const subscription of desired.values()) sendRaw({ command: "subscribe", identifier: subscription.identifier });
  }

  function scheduleReconnect(): void {
    if (closingForPageHide || reconnectTimer) return;
    const delay = delays[Math.min(attempts++, delays.length - 1)]!;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function handleMessage(event: MessageEvent): void {
    const message = decodeCableServerMessage(String(event.data));
    switch (message.type) {
      case "welcome":
        attempts = 0;
        activeConnectionId = message.connectionId;
        resubscribeAll();
        break;
      case "confirm_subscription": {
        const key = serializeCableIdentifier(message.identifier);
        const subscription = desired.get(key);
        if (!subscription) break;
        if (message.html) window.Turbo?.renderStreamMessage(message.html);
        requestAnimationFrame(() => {
          if (desired.get(key) !== subscription) return;
          subscription.ready = true;
          subscription.onReady?.();
        });
        break;
      }
      case "reject_subscription":
        console.error("Cable subscription rejected", message);
        break;
      case "turbo_stream": {
        if (desired.has(serializeCableIdentifier(message.identifier))) window.Turbo?.renderStreamMessage(message.html);
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
    const connecting = new WebSocket(cableUrl());
    socket = connecting;
    connecting.onmessage = handleMessage;
    connecting.onclose = () => {
      if (socket !== connecting) return;
      socket = undefined;
      activeConnectionId = undefined;
      if (!closingForPageHide) {
        for (const subscription of desired.values()) {
          if (subscription.ready) subscription.onDisconnected?.();
          subscription.ready = false;
        }
      }
      scheduleReconnect();
    };
    connecting.onerror = () => connecting.close();
  }

  window.addEventListener("pagehide", () => {
    closingForPageHide = true;
    socket?.close();
  });
  window.addEventListener("pageshow", () => {
    closingForPageHide = false;
    if (desired.size > 0) connect();
  });

  const client: AtelierCableClient = {
    subscribe(identifier, options) {
      const key = serializeCableIdentifier(identifier);
      const existing = desired.get(key);
      if (existing) {
        existing.onReady = options?.onReady;
        existing.onDisconnected = options?.onDisconnected;
        closingForPageHide = false;
        connect();
        if (existing.ready) requestAnimationFrame(() => {
          if (desired.get(key) === existing) existing.onReady?.();
        });
        return;
      }
      desired.set(key, { identifier, ready: false, onReady: options?.onReady, onDisconnected: options?.onDisconnected });
      closingForPageHide = false;
      connect();
      sendRaw({ command: "subscribe", identifier });
    },
    unsubscribe(identifier) {
      const key = serializeCableIdentifier(identifier);
      desired.delete(key);
      sendRaw({ command: "unsubscribe", identifier });
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
