export const observableTerminalCols = 120;
export const observableTerminalRows = 30;
export const observableTerminalHistoryLimit = 100_000;
export const observableTerminalEnvironment = {
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
} as const;
