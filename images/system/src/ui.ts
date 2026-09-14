import { buttonHtml } from "../../../packages/design-system/src/button/button-html.ts";
export const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const button = (caption: string) =>
  buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption },
  });
export function page(title: string, content: string, assetOrigin = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="${escape(assetOrigin)}/design-system.css"><style>body{margin:0;padding:3rem;font-family:var(--font-sans);background:var(--bg);color:var(--text)}main{max-width:60rem;margin:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto}form{margin:1rem 0}input{width:min(100%,32rem)}a{color:inherit}</style><script type="module" src="${escape(assetOrigin)}/client.js"></script></head><body><main>${content}</main></body></html>`;
}
