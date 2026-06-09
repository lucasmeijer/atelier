export const terminalStaticFiles = {
  "/terminal.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/ghostty-vt.wasm": { url: new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm")), contentType: "application/wasm" },
  "/fonts/jetbrains-mono-latin-300-normal.woff2": { url: new URL(import.meta.resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-300-normal.woff2")), contentType: "font/woff2" },
} as const;
