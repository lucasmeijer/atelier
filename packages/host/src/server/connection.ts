import { hostOriginAllowed } from "./authorization.ts";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { hostSocketPath, terminalSize, type HostReply, type HostCommand, type HostResults } from "../protocol.ts";
import type { WorkspaceServerSocketHandler } from "@atelier/shared";

export const hostAvailable = () => existsSync(hostSocketPath);
export function hostRequest<Command extends HostCommand>(request: Command, socketPath = hostSocketPath): Promise<HostResults[Command["operation"]]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const lines = createInterface({ input: socket });
    let settled = false;
    socket.setTimeout(15000, () => socket.destroy(new Error("Host request timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("error", reject);
    socket.on("close", () => { lines.close(); if (!settled) reject(new Error("Host disconnected before responding")); });
    lines.once("line", line => {
      settled = true;
      try {
        const reply: HostReply = JSON.parse(line);
        if (reply.type === "error") reject(new Error(reply.message));
        else if (reply.type === "result") {
          // SAFETY: The private System protocol returns the result associated with this command.
          resolve(reply.value as HostResults[Command["operation"]]);
        }
        else reject(new Error("Unexpected host response"));
      } catch (error) { reject(error); }
      socket.end();
    });
  });
}

export const hostTerminalSocket: WorkspaceServerSocketHandler = (url, request) => {
  const match = url.pathname.match(/^\/host\/terminals\/(host-[a-f0-9-]{36})\/ws$/);
  if (!match || !hostOriginAllowed(request)) return;
  let upstream: ReturnType<typeof createConnection> | undefined;
  let clientOpen = false;
  return {
    open(client) {
      clientOpen = true;
      upstream = createConnection(hostSocketPath);
      const lines = createInterface({ input: upstream });
      // Queue the handshake before the browser can send its initial resize.
      upstream.write(`${JSON.stringify({ operation: "attach", id: match[1], cols: terminalSize(url.searchParams.get("cols"), 80), rows: terminalSize(url.searchParams.get("rows"), 24) })}\n`);
      lines.on("line", line => {
        if (!clientOpen) return;
        const reply: HostReply = JSON.parse(line);
        if (reply.type === "output") client.send(Buffer.from(reply.data, "base64"));
        if (reply.type === "error") { client.send(`\r\n${reply.message}\r\n`); client.close(); }
        if (reply.type === "exit") client.close();
      });
      upstream.on("error", error => { console.error("Host terminal connection failed", error); client.close(1011, "Host terminal connection failed"); });
      upstream.on("close", () => { lines.close(); client.close(); });
    },
    message(_client, message) { upstream!.write(`${JSON.stringify(message instanceof Uint8Array ? new TextDecoder().decode(message) : message)}\n`); },
    close() { clientOpen = false; upstream?.destroy(); },
  };
};
