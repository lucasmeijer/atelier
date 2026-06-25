/** HTML/turbo-stream helpers for the agent module. */

export { domId, escapeHtml, turboStream, turboStreamResponse } from "@atelier/shared";

export function sseFrame(html: string): string {
  return `${html.split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`;
}
