export const observableTerminalStaticFiles = {
  "/observable-terminal.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/xterm.css": { url: new URL(import.meta.resolve("@xterm/xterm/css/xterm.css")), contentType: "text/css; charset=utf-8" },
} as const;
