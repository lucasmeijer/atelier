export interface ObservableTerminalResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

export interface ObservableTerminalProgressMessage {
  type: "progress";
  state: number;
  value?: number;
}

export type ObservableTerminalControlMessage = ObservableTerminalResizeMessage | ObservableTerminalProgressMessage;

interface ObservableTerminalMessageCandidate {
  type?: unknown;
  cols?: unknown;
  rows?: unknown;
  state?: unknown;
  value?: unknown;
}

export function encodeObservableTerminalMessage(message: ObservableTerminalControlMessage): string {
  return JSON.stringify(message);
}

export function parseObservableTerminalMessage(text: string): ObservableTerminalControlMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  // SAFETY: ObservableTerminalMessageCandidate only names optional properties with unknown values.
  const object = parsed as ObservableTerminalMessageCandidate;
  if (object.type === "resize") {
    const cols = Number(object.cols);
    const rows = Number(object.rows);
    return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 ? { type: "resize", cols, rows } : undefined;
  }
  if (object.type === "progress") {
    const state = Number(object.state);
    const value = object.value === undefined ? undefined : Number(object.value);
    return Number.isInteger(state) && state >= 0 && state <= 4 && (value === undefined || Number.isFinite(value)) ? { type: "progress", state, value } : undefined;
  }
  return undefined;
}
