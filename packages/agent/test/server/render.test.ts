import { describe, expect, test } from "bun:test";
import { renderAgentPane, renderAgentPaneComposer, renderAgentPaneComposerFooter, renderPromptActions } from "../../src/server/render-composer.ts";
import { renderTranscript, renderTranscriptItem, renderTranscriptItemDetailFrame } from "../../src/server/render-transcript.ts";
import type { AgentRenderContext } from "../../src/server/render-context.ts";
import type { ToolView, TranscriptItem } from "../../src/server/transcript.ts";

const ctx: AgentRenderContext = { workspaceId: "ws", conversationId: "00000000-0000-4000-8000-000000000001" };
const agent = { workspaceId: "ws", conversationId: "00000000-0000-4000-8000-000000000001", label: "agent", title: "Agent", path: "/tmp/agent.jsonl" };
const ctxPrefix = `ag_ws_${agent.conversationId}`;
const tool = (overrides: Partial<ToolView>): ToolView => ({ callId: "call", name: "read", args: {}, status: "ok", ...overrides });
const renderBash = (command: string, overrides: Partial<ToolView> = {}): string => renderTranscriptItemDetailFrame(ctx, { type: "tool", key: "bash", tool: tool({ name: "bash", args: { command }, ...overrides }) });
const renderedText = (html: string): string => html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "");
const firstEditModel = (html: string): Array<{ name: string; hunks: Array<{ collapsedBefore?: number; additionLines: number; deletionLines: number; hunkContent: Array<{ type: string; lines?: number }> }> }> => {
  const source = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/)![1]!;
  return JSON.parse(source);
};

describe("transcript rendering", () => {
  test("server-rendered panes and routes use immutable conversation identity", async () => {
    const stats = { contextPercent: null, compactAvailable: false, inputTokens: 0, outputTokens: 0, cost: 0, modelName: undefined, thinkingLevel: "off", thinkingLevels: [], models: [] };
    const html = await renderAgentPane(ctx, agent, { transcriptHtml: "ready", busy: false, stats });
    expect(html).toContain(`data-agent-pane-conversation-id-value="${agent.conversationId}"`);
    expect(html).toContain(`/agents/${agent.conversationId}/messages`);
    expect(html).not.toContain("data-agent-pane-label-value");
  });

  test("AgentPaneComposer runs completion shortcuts before prompt submission", async () => {
    const html = await renderAgentPaneComposer({ action: "/messages", placeholder: "Ask", draftId: "draft", ctx, formTarget: true, includePaneActions: true, stats: { contextPercent: null, compactAvailable: false, inputTokens: 0, outputTokens: 0, cost: 0, modelName: undefined, thinkingLevel: "off", thinkingLevels: [], models: [] } });
    expect(html).toContain("agent-completions");
    expect(html).toContain('data-action="keydown-&gt;agent-completions#keydown keydown-&gt;agent-pane#inputKeydown submit-&gt;transcription-composer#submit turbo:submit-end-&gt;agent-pane#submitted click-&gt;agent-pane#focusInput"');
    expect(html).toContain('data-action="input->agent-completions#input input->agent-pane#promptChanged"');
    expect(html).toContain('enterkeyhint="send"');
    expect(html).toContain('data-agent-pane-target="sendStop"');
  });

  test("busy composers expose an actionable indeterminate stop button", () => {
    const active = renderPromptActions(ctx, true);
    expect(active).toContain('type="submit"');
    expect(active).toContain(`form="${ctxPrefix}_abort_form"`);
    expect(active).not.toContain('name="mode"');
    expect(active).toContain('data-activity-state="active"');
    expect(active).toContain('aria-label="Agent is working — click to stop"');
    expect(active).toContain('aria-busy="true"');
    expect(active).not.toContain(" disabled");

    const initial = renderPromptActions(ctx, false);
    expect(initial).toContain('data-activity-state="initial"');
    expect(initial).toContain('aria-label="Send prompt"');
    expect(initial).not.toContain('aria-busy="true"');
  });

  test("user messages retain their original text for keyboard prompt history", () => {
    const html = renderTranscriptItem(ctx, { type: "user", key: "user-history", text: "**bold** & quoted \"text\"", images: [] });
    expect(html).toContain('data-agent-user-text="**bold** &amp; quoted &quot;text&quot;"');
  });

  test("composers omit Fast mode", () => {
    const html = renderAgentPaneComposerFooter(ctx, { contextPercent: null, compactAvailable: false, inputTokens: 0, outputTokens: 0, cost: 0, modelName: "GPT", thinkingLevel: "high", thinkingLevels: ["high"], models: [] });
    expect(html).toContain('data-agent-compact-available="false"');
    expect(html).not.toContain('aria-label="Fast mode"');
    expect(html).not.toContain("/service-tier");
  });

  test("completed activity with no items is omitted", () => {
    const html = renderTranscriptItem(ctx, { type: "working", key: "worked", startedAt: 1000, completedAt: 3500, items: [] });
    expect(html).toBe("");
  });


  test("live assistant text uses stable and mutable server-rendered Markdown targets", () => {
    const html = renderTranscriptItem(ctx, { type: "text", key: "stream", text: "First **bold** paragraph.\n\nTrailing *emphasis*", final: false, live: true });
    expect(html).toContain(`id="${ctxPrefix}_itemtext_stable_stream"`);
    expect(html).toContain(`id="${ctxPrefix}_itemtext_tail_stream"`);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>emphasis</em>");
  });

  test("places transient notices after transcript items", () => {
    const html = renderTranscript(ctx, [{ type: "user", key: "user", text: "question", images: [] }], { systemPrompt: "", tools: [] });
    const itemIndex = html.indexOf(`id="${ctxPrefix}_item_user"`);
    const noticesIndex = html.indexOf(`id="${ctxPrefix}_notices"`);
    expect(itemIndex).toBeGreaterThan(-1);
    expect(noticesIndex).toBeGreaterThan(itemIndex);
  });

  test("read summaries include ranges", () => {
    const item: TranscriptItem = { type: "tool", key: "read-range", tool: tool({ name: "read", args: { path: "a.ts", offset: 40, limit: 80 } }) };
    expect(renderTranscript(ctx, [item], { systemPrompt: "", tools: [] })).toContain("a.ts:40-119");

    const streaming = renderTranscriptItem(ctx, { ...item, tool: { ...item.tool, status: "streaming" } }, { live: true });
    expect(streaming).toContain("agent-tool-summary-only");
    expect(streaming).not.toContain("agent-tool-detail");
  });

  test("bash summaries only show non-zero exit codes", () => {
    const successful: TranscriptItem = { type: "tool", key: "bash-ok", tool: tool({ name: "bash", durationMs: 1000, details: { exitCode: 0 } }) };
    const failed: TranscriptItem = { type: "tool", key: "bash-failed", tool: tool({ name: "bash", durationMs: 1000, details: { exitCode: 2 } }) };
    expect(renderTranscriptItem(ctx, successful)).not.toContain("exitcode 0");
    expect(renderTranscriptItem(ctx, failed)).toContain("exitcode 2");
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
    expect(detail.replace(/<[^>]+>/g, "")).toContain("const x = 1;");
    expect(detail).toContain('data-controller="atelier-fullscreen"');
  });

  test("streaming write renders decoded content", () => {
    const item: TranscriptItem = { type: "tool", key: "stream-write", tool: tool({ name: "write", status: "streaming", argsStream: '{"path":"a.ts","content":"x\\ny"}' }) };
    const html = renderTranscriptItem(ctx, item, { live: true, open: true });
    expect(renderedText(html)).toContain("x\ny");
    expect(html).not.toContain("\\n");
  });

  test("streaming tools isolate changing content from their status spinner", () => {
    const item: TranscriptItem = { type: "tool", key: "stream-write", tool: tool({ name: "write", status: "streaming", argsStream: '{"path":"a.ts","content":"x"' }) };
    const html = renderTranscriptItem(ctx, item, { live: true, open: true });
    const status = html.indexOf('aria-label="In progress"');
    const summaryContent = html.indexOf(`id="${ctxPrefix}_summary_content_stream-write"`);
    expect(status).toBeGreaterThan(-1);
    expect(summaryContent).toBeGreaterThan(status);
    expect(html).toContain("agent-tool-detail-host");
  });

  test("live write pagination targets its detail frame", () => {
    const content = Array.from({ length: 700 }, (_, index) => `line ${index + 1}`).join("\n");
    const item: TranscriptItem = { type: "tool", key: "live-write", tool: tool({ name: "write", args: { path: "a.ts", content } }) };
    const html = renderTranscriptItem(ctx, item, { live: true, open: true });
    expect(html).toContain(`<turbo-frame id="${ctxPrefix}_detail_live-write"`);
    expect(html).toContain(`data-turbo-frame="${ctxPrefix}_detail_live-write"`);
    expect(html).toContain("?count=600");
    expect(html).toContain("show 500 more lines");
  });

  test("pagination labels the number of lines that remain", () => {
    const content = Array.from({ length: 220 }, (_, index) => `line ${index + 1}`).join("\n");
    const item: TranscriptItem = { type: "tool", key: "short-write", tool: tool({ name: "write", args: { path: "a.ts", content } }) };
    const html = renderTranscriptItemDetailFrame(ctx, item);
    expect(html).toContain("?count=220");
    expect(html).toContain("show 120 more lines");
    expect(html).not.toContain("show 500 more lines");
  });

  test("pagination links scroll with their result content", () => {
    const content = Array.from({ length: 101 }, (_, index) => `line ${index + 1}`).join("\n");
    const write = renderTranscriptItemDetailFrame(ctx, { type: "tool", key: "write-scroll", tool: tool({ name: "write", args: { path: "a.ts", content } }) });
    const writeWindow = write.indexOf('class="agent-tail-output"');
    expect(writeWindow).toBeGreaterThan(-1);
    expect(write.indexOf('class="agent-tool-code', writeWindow)).toBeGreaterThan(writeWindow);
    expect(write.indexOf('class="agent-more-lines"', writeWindow)).toBeGreaterThan(write.indexOf('class="agent-tool-code', writeWindow));

    const bash = renderBash("seq 1 101", { resultText: content, details: { displayAnsi: content } });
    const bashWindow = bash.indexOf('class="agent-tail-output"');
    expect(bashWindow).toBeGreaterThan(-1);
    expect(bash.indexOf('class="agent-more-lines"', bashWindow)).toBeGreaterThan(bashWindow);
    expect(bash.indexOf('class="agent-tool-result', bashWindow)).toBeGreaterThan(bash.indexOf('class="agent-more-lines"', bashWindow));
  });

  test("streaming edits remain a summary until an edit is available", () => {
    const item: TranscriptItem = { type: "tool", key: "edit-stream", tool: tool({ name: "edit", status: "streaming", args: undefined, argsStream: '{"path":"a.ts"' }) };
    const html = renderTranscriptItem(ctx, item, { live: true });
    expect(html).toContain("agent-tool-summary-only");
    expect(html).not.toContain("agent-tool-detail");
    expect(html).not.toContain("copy-button");
    expect(html).not.toContain("disclosure-icon");
  });

  test("running edits wait for the authoritative result before rendering a diff", () => {
    const item: TranscriptItem = { type: "tool", key: "edit-live", tool: tool({ name: "edit", status: "running", args: { path: "a.ts", oldText: "old", newText: "new" } }) };
    const html = renderTranscriptItem(ctx, item, { live: true });
    expect(html).toContain("agent-tool-summary-only");
    expect(html).not.toContain("agent-tool-detail");
    expect(html).not.toContain('data-controller="agent-edit-diff"');
  });

  test("completed edits distinguish removals and additions", () => {
    const item: TranscriptItem = { type: "tool", key: "edit-1", tool: tool({ name: "edit", args: { path: "a.ts", oldText: "const old = 1;", newText: "const next = 2;" } }) };
    const html = renderTranscriptItemDetailFrame(ctx, item);
    expect(html).toContain('data-controller="agent-edit-diff"');
    expect(html).toContain("<diffs-container></diffs-container>");
    const hunk = firstEditModel(html)[0]!.hunks[0]!;
    expect(hunk.deletionLines).toBe(1);
    expect(hunk.additionLines).toBe(1);
  });

  test("edit details keep three unchanged lines around each change", () => {
    const oldText = ["above 1", "above 2", "above 3", "above 4", "const old = 1;", "below 1", "below 2", "below 3", "below 4"].join("\n");
    const newText = oldText.replace("const old = 1;", "const next = 2;");
    const item: TranscriptItem = { type: "tool", key: "edit-context", tool: tool({ name: "edit", args: { path: "a.ts", oldText, newText } }) };
    const html = renderTranscriptItemDetailFrame(ctx, item);
    const previewHunk = firstEditModel(html)[0]!.hunks[0]!;
    expect(previewHunk.collapsedBefore).toBe(1);
    expect(previewHunk.hunkContent[0]).toMatchObject({ type: "context", lines: 3 });
    expect(previewHunk.hunkContent.at(-1)).toMatchObject({ type: "context", lines: 3 });
    expect(html.match(/data-controller="agent-edit-diff"/g)).toHaveLength(2);
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
    const hunk = firstEditModel(html)[0]!.hunks[0]!;
    expect(hunk.deletionLines).toBe(1);
    expect(hunk.additionLines).toBe(1);
    expect(hunk.hunkContent[0]).toMatchObject({ type: "context", lines: 3 });
    expect(hunk.hunkContent.at(-1)).toMatchObject({ type: "context", lines: 3 });
  });

  test("running bash starts its live terminal hidden until output is visible", () => {
    const html = renderBash("sleep 5", { status: "running", tmuxSession: "bash-session", terminalVisible: true });
    expect(html).toContain("agent-bash-output agent-terminal-awaiting-output");
  });

  test("bash has separate command and differing model result", () => {
    const html = renderBash("echo one\necho two", { resultText: "plain", details: { exitCode: 0, displayAnsi: "\u001b[31mred\u001b[0m" }, durationMs: 2000 });
    expect(html).toContain("Command");
    expect(html).toContain("Result");
    expect(html).toContain("As emitted");
    expect(html).toContain("As seen by model");
    expect(html).toContain('aria-label="Copy command to clipboard"');
    expect(html).toContain('aria-label="Copy colored result to clipboard"');
    expect(html).toContain('aria-label="Copy model result to clipboard"');
    expect(html).toContain("color:var(--danger)");
  });

  test("formatted bash commands expose the original without adding an output comparison", () => {
    const html = renderBash("printf alpha | grep a", { resultText: "same", details: { displayAnsi: "same" } });
    expect(html).toContain('class="text-toggle subtle" role="group" aria-label="Command view"');
    expect(html).toContain("Original");
    expect(html).not.toContain('aria-label="Result view"');
  });

  test("bash boolean operators have distinct syntax colors outside strings and comments", () => {
    const html = renderBash(`echo "left && right || fallback" && next || stop # && ||`, { resultText: "ok", details: { displayAnsi: "ok" } });
    expect(html.match(/class="agent-bash-and"/g)).toHaveLength(2);
    expect(html.match(/class="agent-bash-or"/g)).toHaveLength(2);
    expect(html).toContain("left &amp;&amp; right || fallback");
    expect(html).toContain("# &amp;&amp; ||");
  });

  test("embedded eval source has separate readable and original views", () => {
    const command = `node -e "const answer={value:42};console.log(answer);"`;
    const html = renderBash(command, { resultText: "ok", details: { exitCode: 0, displayAnsi: "ok" } });
    expect(html).toContain('class="language-javascript"');
    expect(html).toContain("Original");
    expect(html).toContain('aria-label="Copy readable command to clipboard"');
    expect(html).toContain('aria-label="Copy original command to clipboard"');
  });

  test("differing bash output adds a model comparison without adding a command comparison", () => {
    const html = renderBash("echo ok", { resultText: "model output", details: { displayAnsi: "display output" } });
    expect(html).toContain('class="text-toggle subtle" role="group" aria-label="Result view"');
    expect(html).not.toContain('aria-label="Command view"');
  });

  test("identical bash command and output omit model comparisons", () => {
    const html = renderBash("echo ok", { resultText: "ok", details: { exitCode: 0, displayAnsi: "ok" } });
    expect(html).not.toContain('aria-label="Command view"');
    expect(html).not.toContain('aria-label="Result view"');
    expect(html).not.toContain("As seen by model");
  });

  test("thinking uses the truncated renderer by default", () => {
    const html = renderTranscript(ctx, [{ type: "thinking", key: "thought", text: "secret" }], { systemPrompt: "", tools: [] });
    expect(html).toContain('data-controller="agent-thinking"');
    expect(html).toContain("secret");
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
