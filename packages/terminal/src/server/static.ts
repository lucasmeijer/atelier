export const terminalStaticFiles = {
  "/terminal.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/xterm.css": { url: new URL(import.meta.resolve("@xterm/xterm/css/xterm.css")), contentType: "text/css; charset=utf-8" },
  "/fonts/jetbrains-mono-latin-300-normal.woff2": { url: new URL(import.meta.resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-300-normal.woff2")), contentType: "font/woff2" },
} as const;
