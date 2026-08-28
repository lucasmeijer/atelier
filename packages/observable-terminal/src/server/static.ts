export const observableTerminalStaticFiles = {
  "/observable-terminal.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/gespenst.css": { url: new URL(import.meta.resolve("@gespenst/core/style.css")), contentType: "text/css; charset=utf-8" },
  "/ghostty-vt.wasm": { url: new URL(import.meta.resolve("@gespenst/core/ghostty-vt.wasm")), contentType: "application/wasm" },
  "/ghostty-callbacks.wasm": { url: new URL(import.meta.resolve("@gespenst/core/ghostty-callbacks.wasm")), contentType: "application/wasm" },
} as const;
