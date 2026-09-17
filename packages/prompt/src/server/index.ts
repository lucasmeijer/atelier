export * from "./attachment-drafts.ts";
export { renderAttachmentChip } from "./render-attachments.ts";
import type { WorkspaceModule } from "@atelier/shared";
import { handleAttachmentRequest } from "./attachment-routes.ts";
export const atelierServerModule: WorkspaceModule = {
  id: "prompt",
  staticFiles: { "/prompt.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [{ handle: handleAttachmentRequest }],
};
