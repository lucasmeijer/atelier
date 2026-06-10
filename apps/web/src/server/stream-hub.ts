export interface StreamHub {
  subscribe(subscriber: (html: string) => void): () => void;
  broadcast(html: string): void;
  /**
   * SSE endpoint compatible with Turbo's native <turbo-stream-source>:
   * each message's data is raw turbo-stream HTML (multi-line `data:` framing).
   */
  sseResponse(initial?: () => string): Response;
}

function sseFrame(html: string): string {
  return `${html.split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`;
}

export function createStreamHub(): StreamHub {
  const subscribers = new Set<(html: string) => void>();

  return {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },

    broadcast(html) {
      if (!html) return;
      for (const subscriber of subscribers) subscriber(html);
    },

    sseResponse(initial) {
      const encoder = new TextEncoder();
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let send: ((html: string) => void) | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          send = (html: string) => {
            try {
              controller.enqueue(encoder.encode(sseFrame(html)));
            } catch {
              // Stream already closed.
            }
          };
          subscribers.add(send);
          const initialHtml = initial?.();
          if (initialHtml) send(initialHtml);
          keepalive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: keepalive\n\n`));
            } catch {
              // Stream already closed.
            }
          }, 5000);
        },
        cancel() {
          if (send) subscribers.delete(send);
          if (keepalive) clearInterval(keepalive);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        },
      });
    },
  };
}
