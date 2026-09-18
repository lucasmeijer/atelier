import { parseObservableTerminalMessage, type ObservableTerminalProgressMessage } from "../shared/index.ts";
import { attachObservableTerminal, type ObservableTerminalAttachOptions, type ObservableTerminalConnection } from "./attach.ts";

interface TerminalSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

export function terminalSocketDimensions(url: URL) {
  const dimension = (name: string, fallback: number): number => {
    const value = Number(url.searchParams.get(name));
    return Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback;
  };
  return { cols: dimension("cols", 80), rows: dimension("rows", 24) };
}

/** Own one attachment per socket, including final-output ordering and detach. */
export function createObservableTerminalSocket(options: ObservableTerminalAttachOptions, events: {
  onProgress?: (progress: ObservableTerminalProgressMessage) => void;
  onClose?: () => void;
} = {}) {
  let terminal: ObservableTerminalConnection | undefined;
  const decoder = new TextDecoder();
  return {
    open(socket: TerminalSocket): void {
      try {
        terminal = attachObservableTerminal(options, {
          onData: (chunk) => socket.send(chunk),
          onExit: () => socket.close(),
        });
      } catch (error) {
        socket.send(`\r\n[terminal attach failed: ${error instanceof Error ? error.message : String(error)}]\r\n`);
        socket.close();
      }
    },
    message(_socket: TerminalSocket, input: string | Uint8Array): void {
      if (options.readonly) return;
      const text = input instanceof Uint8Array ? decoder.decode(input) : input;
      const control = parseObservableTerminalMessage(text);
      if (control?.type === "resize") {
        if (!options.fixedSize) terminal?.resize(control.cols, control.rows);
      } else if (control?.type === "progress") events.onProgress?.(control);
      else terminal?.write(text);
    },
    close(): void {
      terminal?.close();
      terminal = undefined;
      events.onClose?.();
    },
  };
}
