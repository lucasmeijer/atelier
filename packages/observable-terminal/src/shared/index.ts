export interface ObservableTerminalResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

export type ObservableTerminalProgressState = 0 | 1 | 2 | 3 | 4;

export interface ObservableTerminalProgressMessage {
  type: "progress";
  state: ObservableTerminalProgressState;
  value?: number;
}

export type ObservableTerminalControlMessage = ObservableTerminalResizeMessage | ObservableTerminalProgressMessage;

export function encodeObservableTerminalMessage(message: ObservableTerminalControlMessage): string {
  return JSON.stringify(message);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isObservableTerminalProgressState(value: unknown): value is ObservableTerminalProgressState {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4;
}

export function parseObservableTerminalMessage(text: string): ObservableTerminalControlMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || !("type" in value)) return undefined;

  if (value.type === "resize" && "cols" in value && "rows" in value) {
    const { cols, rows } = value;
    return isPositiveInteger(cols) && isPositiveInteger(rows) ? { type: "resize", cols, rows } : undefined;
  }

  if (value.type === "progress" && "state" in value) {
    const state = value.state;
    const progressValue = "value" in value ? value.value : undefined;
    return isObservableTerminalProgressState(state)
      && (progressValue === undefined || (typeof progressValue === "number" && Number.isFinite(progressValue)))
      ? { type: "progress", state, value: progressValue }
      : undefined;
  }

  return undefined;
}
