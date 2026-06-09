import type { WorkspaceModule } from "@atelier/shared";
import { collectHealthSnapshot } from "./metrics.ts";
import {
  domId,
  escapeHtml,
  renderFacts,
  renderHealthPane,
  renderHealthTab,
  renderProcesses,
  renderSummary,
  renderWarnings,
} from "./render.ts";

export const containerHealthWorkspaceModule: WorkspaceModule = {
  id: "container-health",
  attachToWorkspace({ workspaceId }) {
    return { tabs: [renderHealthTab(workspaceId)] };
  },
};

export function healthPaneEndpoint(workspaceId: string): Response {
  return htmlResponse(renderHealthPane(workspaceId));
}

export function containerHealthStreamEndpoint(workspaceId: string): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let previous: Awaited<ReturnType<typeof collectHealthSnapshot>>["counters"];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data.replaceAll("\n", "\\n")}\n\n`));
      };
      const sendHealth = async () => {
        try {
          const collected = await collectHealthSnapshot(workspaceId, previous);
          previous = collected.counters;
          const snapshot = collected.snapshot;
          const streams = [
            replaceStream(domId("health_summary", workspaceId), renderSummary(workspaceId, snapshot.summary)),
            replaceStream(domId("health_processes", workspaceId), renderProcesses(workspaceId, snapshot.processes, snapshot.errors.processes)),
            replaceStream(domId("health_warnings", workspaceId), renderWarnings(workspaceId, snapshot.warnings)),
            replaceStream(domId("health_facts", workspaceId), renderFacts(workspaceId, snapshot.facts, snapshot.errors.facts)),
          ].join("");
          send("health", JSON.stringify({ streams, graph: snapshot.graph }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          send("health", JSON.stringify({ streams: replaceStream(domId("health_warnings", workspaceId), renderWarnings(workspaceId, [message])), graph: undefined }));
        }
      };
      void sendHealth();
      interval = setInterval(() => void sendHealth(), 1500);
      heartbeat = setInterval(() => send("ping", "{}"), 15000);
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
    },
  });
}

function replaceStream(target: string, html: string): string {
  return `<turbo-stream action="replace" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
}

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
