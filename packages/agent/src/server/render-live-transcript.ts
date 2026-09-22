import { escapeHtml, liveCollection, type LiveRegion } from "@atelier/shared";
import { commentaryContext, ids, type AgentRenderContext } from "./render-context.ts";
import { renderModelContextEntries, renderTranscriptItem, type AgentModelContextView } from "./render-transcript.ts";
import type { TranscriptItem, WorkingTranscriptItem } from "./transcript.ts";

export class LiveTranscriptRenderer {
  private readonly cache = new Map<string, { fingerprint: string; html: string }>();
  clear(): void { this.cache.clear(); }

  private rows(ctx: AgentRenderContext, items: readonly TranscriptItem[], initial = false) {
    return items.map(item => {
      const children: LiveRegion[] = [];
      let view = item;
      if (item.type === "working" && !initial) {
        view = { ...item, items: item.items.filter(child => child.type !== "text") };
        const commentary = commentaryContext(ctx);
        children.push(liveCollection(ids.workingItems(commentary, item.key), this.rows(commentary, item.items.filter(child => child.type === "text"))));
      }
      const rendering = !initial && item.type === "text" && item.live ? ctx.streamingText!(item.key, item.text) : undefined;
      const key = ids.item(ctx, item.key);
      const fingerprint = initial || item.type === "working" || item.type === "extension" ? undefined : JSON.stringify(rendering ? { ...item, text: "" } : item);
      const cached = this.cache.get(key);
      const html = fingerprint !== undefined && cached?.fingerprint === fingerprint ? cached.html
        : renderTranscriptItem(rendering ? { ...ctx, streamingText: () => ({ stableHtml: "", tailHtml: "" }) } : ctx, view);
      if (fingerprint !== undefined) this.cache.set(key, { fingerprint, html });
      if (rendering) children.push(
        { target: ids.itemTextStable(ctx, item.key), html: rendering.stableHtml, appendOnly: true },
        { target: ids.itemTextTail(ctx, item.key), html: rendering.tailHtml },
      );
      return { id: `${ids.item(ctx, item.key)}_region`, html, children };
    });
  }

  private transcriptRows(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView, initial: boolean) {
    return [
      { id: `${ids.transcript(ctx)}_context`, html: renderModelContextEntries(ctx, modelContext) },
      ...this.rows(ctx, items, initial),
    ];
  }

  renderInitialTranscript(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView): string {
    return this.transcriptRows(ctx, items, modelContext, true)
      .map(row => `<div id="${escapeHtml(row.id)}" data-turbo-permanent>${row.html}</div>`).join("") + this.noticesMount(ctx);
  }

  renderTranscript(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView): LiveRegion {
    const region = liveCollection(ids.transcript(ctx), this.transcriptRows(ctx, items, modelContext, false));
    // Notices are browser-owned ephemeral messages, never snapshot state.
    region.html += this.noticesMount(ctx);
    return region;
  }

  private noticesMount(ctx: AgentRenderContext): string {
    return `<div id="${escapeHtml(ids.notices(ctx))}" class="agent-notices" data-turbo-permanent></div>`;
  }

  renderTurn(ctx: AgentRenderContext, turn: WorkingTranscriptItem): LiveRegion {
    return liveCollection(ids.workingItems(ctx, turn.key), this.rows(ctx, turn.items));
  }

}
