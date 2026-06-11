export const vscodeStaticFiles: Record<string, { url: URL; contentType: string }> = {
  "/vscode.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
};
