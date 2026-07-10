export const vscodeStaticFiles = {
  "/vscode.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
} as const;
