import { describe, expect, test } from "bun:test";
import { renderAgentComposer, renderAgentPane, renderTranscript, renderTranscriptItem, renderTranscriptItemDetailFrame, type AgentRenderContext } from "../../src/server/render.ts";
import type { ToolView, TranscriptItem } from "../../src/server/transcript.ts";

const ctx: AgentRenderContext = { workspaceId: "ws", label: "agent" };
const tool = (overrides: Partial<ToolView>): ToolView => ({ callId: "call", name: "read", args: {}, status: "ok", ...overrides });
const renderBash = (command: string, overrides: Partial<ToolView> = {}): string => renderTranscriptItemDetailFrame(ctx, { type: "tool", key: "bash", tool: tool({ name: "bash", args: { command }, ...overrides }) });

describe("flat transcript rendering", () => {
  test("server-rendered panes expose their snapshot cursor", async () => {
    const stats = { contextPercent: null, inputTokens: 0, outputTokens: 0, cost: 0, modelName: undefined, provider: undefined, thinkingLevel: "off", thinkingLevels: [], models: [] };
    const html = await renderAgentPane(ctx, { label: "agent" } as never, { transcriptHtml: "ready", busy: false, stats, snapshotCursor: "generation:4" });
    expect(html).toContain('data-agent-pane-snapshot-cursor-value="generation:4"');
  });

  test("composer runs completion shortcuts before prompt submission", async () => {
    const html = await renderAgentComposer({ action: "/messages", placeholder: "Ask", draftId: "draft", ctx, formTarget: true, stats: { contextPercent: null, inputTokens: 0, outputTokens: 0, cost: 0, modelName: undefined, provider: undefined, thinkingLevel: "off", thinkingLevels: [], models: [] } });
    expect(html).toContain('data-controller="agent-attachments agent-completions"');
    expect(html).toContain('data-action="keydown->agent-completions#keydown input->agent-completions#input keydown->agent-pane#inputKeydown input->agent-pane#promptChanged"');
  });

  test("user messages retain their original text for prompt history", () => {
    const html = renderTranscriptItem(ctx, { type: "user", key: "user-history", text: "**bold** & quoted \"text\"", images: [] });
    expect(html).toContain('data-agent-user-text="**bold** &amp; quoted &quot;text&quot;"');
  });

  test("all transcript content uses the same full-width row", () => {
    const items: TranscriptItem[] = [
      { type: "user", key: "user", text: "question", images: [] },
      { type: "text", key: "answer", text: "answer\n\n{{atelier:embed /work/preview.html}}", final: true },
      { type: "tool", key: "read", tool: tool({ name: "read", args: { path: "a.ts" } }) },
    ];
    const html = renderTranscript(ctx, items, { systemPrompt: "system", tools: [] });
    expect(html.match(/class="agent-row"/g)).toHaveLength(5);
  });

  test("read summaries include ranges", () => {
    const item: TranscriptItem = { type: "tool", key: "read-range", tool: tool({ name: "read", args: { path: "a.ts", offset: 40, limit: 80 } }) };
    expect(renderTranscript(ctx, [item], { systemPrompt: "", tools: [] })).toContain("a.ts:40-119");
  });

  test("read results render source without adding line-number markup", () => {
    const item: TranscriptItem = { type: "tool", key: "read-result", tool: tool({ name: "read", args: { path: "a.ts", offset: 40, limit: 2 }, resultText: "const first = 1;\nconst second = 2;" }) };
    const html = renderTranscriptItemDetailFrame(ctx, item);
    expect(html).toContain("hljs-keyword");
    expect(html).not.toContain("agent-numbered-line");
    expect(html).not.toContain("agent-line-number");
  });

  test("historical tools are collapsed and lazy", () => {
    const item: TranscriptItem = { type: "tool", key: "write-1", tool: tool({ name: "write", args: { path: "a.ts", content: "const x = 1;" } }) };
    const html = renderTranscript(ctx, [item], { systemPrompt: "", tools: [] });
    expect(html).toContain("<turbo-frame");
    expect(html).toContain('data-agent-lazy-detail-target="frame"');
    expect(html).toContain('data-src=');
    expect(html).not.toContain(' src=');
    expect(html).not.toContain("const x");
    const detail = renderTranscriptItemDetailFrame(ctx, item);
    expect(detail).toContain("agent-tool-code");
    expect(detail).toContain("const");
    expect(detail).toContain('data-controller="atelier-fullscreen"');
  });

  test("streaming write renders decoded content", () => {
    const item: TranscriptItem = { type: "tool", key: "stream-write", tool: tool({ name: "write", status: "streaming", argsStream: '{"path":"a.ts","content":"x\\ny"}' }) };
    const html = renderTranscriptItem(ctx, item, { live: true, open: true });
    expect(html).toContain("agent-tool-code");
    expect(html).toContain("x\ny");
    expect(html).not.toContain("\\n");
  });

  test("streaming tools isolate changing content from their status spinner", () => {
    const item: TranscriptItem = { type: "tool", key: "stream-write", tool: tool({ name: "write", status: "streaming", argsStream: '{"path":"a.ts","content":"x"' }) };
    const html = renderTranscriptItem(ctx, item, { live: true, open: true });
    const status = html.indexOf("agent-tool-status running");
    const summaryContent = html.indexOf("agent-tool-summary-content");
    expect(status).toBeGreaterThan(-1);
    expect(summaryContent).toBeGreaterThan(status);
    expect(html).toContain("agent-tool-detail-host");
  });

  test("running edit has summary only", () => {
    const item: TranscriptItem = { type: "tool", key: "edit-live", tool: tool({ name: "edit", status: "running", args: { path: "a.ts", oldText: "old", newText: "new" } }) };
    const html = renderTranscriptItem(ctx, item, { live: true });
    expect(html).toContain("agent-tool-summary-only");
    expect(html).not.toContain("agent-tool-detail");
  });

  test("completed edit renders highlighted removals and additions without marks", () => {
    const item: TranscriptItem = { type: "tool", key: "edit-1", tool: tool({ name: "edit", args: { path: "a.ts", oldText: "const old = 1;", newText: "const next = 2;" } }) };
    const html = renderTranscriptItemDetailFrame(ctx, item);
    expect(html).toContain("agent-edit-lines removed");
    expect(html).toContain("agent-edit-lines added");
    expect(html).toContain("hljs-keyword");
    expect(html).not.toContain("diff-mark");
  });

  test("edit details keep three unchanged lines around each change", () => {
    const oldText = ["above 1", "above 2", "above 3", "above 4", "const old = 1;", "below 1", "below 2", "below 3", "below 4"].join("\n");
    const newText = oldText.replace("const old = 1;", "const next = 2;");
    const item: TranscriptItem = { type: "tool", key: "edit-context", tool: tool({ name: "edit", args: { path: "a.ts", oldText, newText } }) };
    const html = renderTranscriptItemDetailFrame(ctx, item);
    const preview = html.split("<template")[0].replace(/<[^>]+>/g, "");
    expect(preview).not.toContain("above 1");
    expect(preview).toContain("above 2");
    expect(preview).toContain("above 4");
    expect(preview).toContain("below 1");
    expect(preview).toContain("below 3");
    expect(preview).not.toContain("below 4");
    const fullscreen = html.replace(/<[^>]+>/g, "");
    expect(fullscreen).toContain("above 1");
    expect(fullscreen).toContain("below 4");
  });

  test("edit details use persisted patch context when arguments only contain the changed line", () => {
    const patch = [
      "--- a/src/main.jsx",
      "+++ b/src/main.jsx",
      "@@ -8,7 +8,7 @@",
      " context 1",
      " context 2",
      " context 3",
      "-WEBGL EXPERIMENT / 001",
      "+WEBGL EXPERIMENT / 002",
      " context 4",
      " context 5",
      " context 6",
    ].join("\n");
    const item: TranscriptItem = { type: "tool", key: "edit-patch", tool: tool({ name: "edit", args: { path: "src/main.jsx", oldText: "WEBGL EXPERIMENT / 001", newText: "WEBGL EXPERIMENT / 002" }, details: { patch } }) };
    const html = renderTranscriptItemDetailFrame(ctx, item).split("<template")[0];
    const preview = html.replace(/<[^>]+>/g, "");
    expect(html).toContain("agent-edit-lines context");
    expect(html).toContain("agent-edit-lines removed");
    expect(html).toContain("agent-edit-lines added");
    expect(preview).toContain("context 1");
    expect(preview).toContain("context 3");
    expect(preview).toContain("context 4");
    expect(preview).toContain("context 6");
  });

  test("bash has separate command and differing model result", () => {
    const html = renderBash("echo one\necho two", { resultText: "plain", details: { exitCode: 0, displayAnsi: "\u001b[31mred\u001b[0m" }, durationMs: 2000 });
    expect(html).toContain("COMMAND");
    expect(html).toContain("RESULT");
    expect(html).toContain("AS SEEN BY MODEL");
    expect(html).toContain("color:var(--red)");
  });

  test("identical bash views omit model tab", () => {
    const html = renderBash("echo ok", { resultText: "ok", details: { exitCode: 0, displayAnsi: "ok" } });
    expect(html).not.toContain("AS SEEN BY MODEL");
  });

  test("thinking uses the truncated renderer by default", () => {
    const html = renderTranscript(ctx, [{ type: "thinking", key: "thought", text: "secret" }], { systemPrompt: "", tools: [] });
    expect(html).toContain('data-controller="agent-thinking"');
    expect(html).toContain("secret");
    expect(html).toContain('hidden>...(show more)</button>');
    expect(html).not.toContain("agent-tool");
    expect(html).not.toContain("turbo-frame");
  });

  test("openai-codex 5.5 and 5.6 model families render full thinking immediately", () => {
    for (const id of ["gpt-5.5", "gpt-5.6-sol"]) {
      const modelCtx: AgentRenderContext = { ...ctx, model: { provider: "openai-codex", id } };
      const html = renderTranscript(modelCtx, [{ type: "thinking", key: "thought", text: "full <thought>" }], { systemPrompt: "", tools: [] });
      expect(html, id).toContain('class="agent-thinking-text expanded"');
      expect(html, id).toContain("full &lt;thought&gt;");
      expect(html, id).not.toContain('data-controller="agent-thinking"');
      expect(html, id).not.toContain("show more");
    }
  });

  test("other providers and model families retain the default thinking renderer", () => {
    for (const model of [{ provider: "openai-codex", id: "gpt-5.4-mini" }, { provider: "openai", id: "gpt-5.6-sol" }]) {
      const modelCtx: AgentRenderContext = { ...ctx, model };
      const html = renderTranscript(modelCtx, [{ type: "thinking", key: "thought", text: "secret" }], { systemPrompt: "", tools: [] });
      expect(html).toContain('data-controller="agent-thinking"');
    }
  });

  test("session images use served URLs and summary metadata", () => {
    const item: TranscriptItem = { type: "tool", key: "image", tool: tool({ name: "read", args: { path: "image.png" }, resultText: "Read image file", resultImages: [{ entryId: "entry", contentIndex: 2, mimeType: "image/png", width: 320, height: 200 }] }) };
    const transcript = renderTranscript(ctx, [item], { systemPrompt: "", tools: [] });
    expect(transcript).toContain("320×200 · image/png");
    const detail = renderTranscriptItemDetailFrame(ctx, item);
    expect(detail).toContain('/session-images/entry/2');
    expect(detail).toContain('data-atelier-fullscreen-mode-value="media"');
  });

  test("user attachments remain fullscreenable", () => {
    const html = renderTranscript(ctx, [{ type: "user", key: "user", text: "look", images: [{ entryId: "user", contentIndex: 1 }] }], { systemPrompt: "", tools: [] });
    expect(html).toContain('/session-images/user/1');
    expect(html).toContain('data-atelier-fullscreen-mode-value="media"');
  });
});
