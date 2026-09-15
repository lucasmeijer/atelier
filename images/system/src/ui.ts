import { actionLinkHtml } from "../../../packages/design-system/src/action-link/action-link-html.ts";
import { buttonHtml } from "../../../packages/design-system/src/button/button-html.ts";
import { actionItemHtml } from "../../../packages/design-system/src/action-item/action-item-html.ts";
import { Icons } from "../../../packages/design-system/src/icons/icons-html.ts";
import { escapeHtml } from "../../../packages/shared/src/html.ts";

export const button = (caption: string) =>
  buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption },
  });
export function page(title: string, content: string, assetOrigin = ""): string {
  return `<!doctype html><html lang="en" data-theme="nord" data-controller="system-theme"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${escapeHtml(assetOrigin)}/design-system.css"><style>
body { margin:0; min-height:100dvh; box-sizing:border-box; display:flex; flex-direction:column; padding:24px 16px; font:var(--text-body)/var(--leading-standard) var(--font-sans); background:var(--bg); color:var(--text); }
main { width:100%; max-width:38rem; margin:auto; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:20rem; overflow:auto; }
form { margin:0; }
p { margin:0 0 16px; }
h1 { margin:0; color:var(--text-bright); font:var(--weight-semibold) var(--text-title)/var(--leading-standard) var(--font-sans); }
.system-checklist { margin:24px 0; }
.system-detail { display:block; margin-top:4px; color:var(--text-muted); font-size:var(--text-code); overflow-wrap:anywhere; }
.system-actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:16px; }
.system-foldout { margin-top:8px; }
.system-foldout-body { padding:12px; overflow-wrap:anywhere; }
.system-error { color:var(--danger); }
.system-log { font:var(--text-code)/var(--leading-standard) var(--font-mono); }
input { width:min(100%,32rem); }
a { color:inherit; }
</style><script type="module" src="${escapeHtml(assetOrigin)}/client.js"></script></head><body><main>${content}</main></body></html>`;
}

export interface SupervisorView {
  operation: "startup" | "update";
  phase: number;
  healthy: boolean;
  stopping: boolean;
  failure?: string;
  candidate: string;
  accessMode: string;
  connectionState: string;
  connectionProblem?: string;
  authUrl?: string;
  logs: string[];
}

function foldout(id: string, label: string, body: string): string {
  return `<details class="system-foldout" id="${id}">${actionItemHtml({ kind: "single", element: { tag: "summary" }, leadingHtml: Icons.Disclosure, label: { kind: "text", text: label } })}<div class="system-foldout-body">${body}</div></details>`;
}

export function supervisorFragment(view: SupervisorView): string {
  const title = view.stopping ? "Stopping Atelier" : view.failure ? "Atelier needs attention" : view.healthy ? "Atelier is ready" : view.operation === "update" ? "Updating Atelier" : "Starting Atelier";
  const labels = ["Prepare Atelier images", "Stop the previous version", "Start Atelier", "Check health", "Open Atelier"];
  const checklist = labels.map((label, index) => {
    const done = view.healthy || index < view.phase;
    const failed = !done && index === view.phase && !!view.failure;
    const running = !done && !failed && index === view.phase;
    return `<li class="status-list__item"${done ? ' role="checkbox" aria-checked="true"' : failed ? ' data-status="failed"' : running ? ' aria-busy="true"' : ''}><span class="status-list__marker"${failed ? ' role="img" aria-label="Failed"' : ''}>${done ? "✓" : failed ? "✕" : ""}</span><div>${label}${failed ? `<span class="system-detail system-error">${escapeHtml(view.failure!)}</span>` : ""}</div></li>`;
  }).join("");

  return `<section aria-label="Atelier System"><h1>${title}</h1>
    <section class="system-checklist" aria-label="Atelier preparation">${view.stopping ? "" : `<ol class="status-list">${checklist}</ol>`}${view.failure && !view.stopping ? `<div class="system-actions"><form method="post" action="/retry">${button("Try again")}</form></div>` : ""}</section>
    ${view.authUrl ? `<p>Sign in to finish setting up remote access.</p>${actionLinkHtml({ href: view.authUrl, variant: "primary", content: { kind: "caption", caption: "Sign in to Tailscale" } })}` : ""}
    ${view.connectionProblem ? `<p class="system-error">${escapeHtml(view.connectionProblem)}</p>` : ""}
    ${foldout("system-logs", "Docker logs", `<pre class="system-log" data-progress-log>${escapeHtml(view.logs.join("\n") || "Waiting for output…")}</pre>`)}
    ${foldout("system-access", "Connection & system details", `<p>Access: ${escapeHtml(view.accessMode)}<br>Tailscale: ${escapeHtml(view.connectionState)}</p><p class="system-detail">Image: ${escapeHtml(view.candidate)}</p><div class="system-actions"><form method="post" action="/connect">${button("Enable remote access")}</form><form method="post" action="/local">${button("Use local access")}</form></div>`)}
  </section>`;
}
