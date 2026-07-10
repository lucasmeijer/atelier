/// <reference lib="dom" />

import { parseCableIdentifier, serializeCableIdentifier, type AtelierCableClient, type CableClientMessage, type CableIdentifier, type CableServerMessage } from "@atelier/shared";

declare global {
  interface Window {
    AtelierCable?: AtelierCableClient;
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

export function createAtelierCableClient(): AtelierCableClient {
  const desired = new Map<string, CableIdentifier>();
  const delays = [100, 250, 500, 1000, 2000, 5000];
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let closingForPageHide = false;

  function cableUrl(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/cable`;
  }

  function sendRaw(message: CableClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function resubscribeAll(): void {
    for (const identifier of desired.values()) sendRaw({ command: "subscribe", identifier });
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
    const message = JSON.parse(String(event.data)) as CableServerMessage;
    switch (message.type) {
      case "welcome":
        attempts = 0;
        resubscribeAll();
        break;
      case "confirm_subscription":
        break;
      case "reject_subscription":
        console.error("Cable subscription rejected", message);
        break;
      case "turbo_stream":
        window.Turbo?.renderStreamMessage(message.html);
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
    socket = new WebSocket(cableUrl());
    socket.onmessage = handleMessage;
    socket.onclose = () => scheduleReconnect();
    socket.onerror = () => socket?.close();
  }

  window.addEventListener("pagehide", () => {
    closingForPageHide = true;
    socket?.close();
  });

  const client: AtelierCableClient = {
    subscribe(identifier) {
      const parsed = parseCableIdentifier(identifier);
      desired.set(serializeCableIdentifier(parsed), parsed);
      closingForPageHide = false;
      connect();
      sendRaw({ command: "subscribe", identifier: parsed });
    },
    unsubscribe(identifier) {
      const parsed = parseCableIdentifier(identifier);
      const key = serializeCableIdentifier(parsed);
      desired.delete(key);
      sendRaw({ command: "unsubscribe", identifier: parsed });
    },
    send(identifier, data) {
      sendRaw({ command: "message", identifier: parseCableIdentifier(identifier), data });
    },
    connected() {
      return socket?.readyState === WebSocket.OPEN;
    },
  };

  return client;
}
