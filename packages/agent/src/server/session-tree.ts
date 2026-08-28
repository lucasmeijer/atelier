import { AtelierCoreError } from "@atelier/core";
import { contentText } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { escapeHtml } from "./html.ts";

interface VisibleTreeNode {
  node: SessionTreeNode;
  children: VisibleTreeNode[];
}

const treeFilterOptions = [
  ["default", "Default"],
  ["no-tools", "No tools"],
  ["user-only", "User only"],
  ["labeled-only", "Labeled"],
  ["all", "All entries"],
] as const;

export type TreeFilterMode = typeof treeFilterOptions[number][0];

export function parseTreeFilterMode(value: string | null): TreeFilterMode {
  return treeFilterOptions.find(([mode]) => mode === value)?.[0] ?? "default";
}

const treeLabelSeparator = " • ";

export function parseTreeLabels(label: string | undefined): string[] {
  return label?.split(treeLabelSeparator).map((part) => part.trim()).filter(Boolean) ?? [];
}

export function serializeTreeLabels(labels: readonly string[]): string | undefined {
  return labels.length ? labels.join(treeLabelSeparator) : undefined;
}

interface FlatTreeEntry {
  node: SessionTreeNode;
  lane: number;
  parentLane: number | null;
  continuationLanes: number[];
  hasChildren: boolean;
  onActivePath: boolean;
}

interface SessionEntryView {
  kind: string;
  text: string;
}

function visibleEntry(node: SessionTreeNode, current: boolean, filter: TreeFilterMode, query: string): boolean {
  const entry = node.entry;
  if (entry.type === "message" && entry.message.role === "assistant" && !current) {
    const message = entry.message;
    const abnormal = Boolean(message.stopReason && message.stopReason !== "stop" && message.stopReason !== "toolUse");
    if (!contentText(message.content).trim() && !abnormal) return false;
  }
  const settings = entry.type === "label" || entry.type === "custom" || entry.type === "model_change" || entry.type === "thinking_level_change" || entry.type === "session_info";
  if (current && filter === "default" && !query) return true;
  if (filter === "default" && settings) return false;
  if (filter === "no-tools" && (settings || (entry.type === "message" && entry.message.role === "toolResult"))) return false;
  if (filter === "user-only" && !(entry.type === "message" && entry.message.role === "user")) return false;
  if (filter === "labeled-only" && !node.label) return false;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length) {
    const view = entryView(entry);
    const searchable = `${node.label ?? ""} ${view.kind} ${view.text}`.toLowerCase();
    if (!tokens.every((token) => searchable.includes(token))) return false;
  }
  return true;
}

function entryView(entry: SessionEntry): SessionEntryView {
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "user") return { kind: "You", text: contentText(message.content) };
    if (message.role === "assistant") return { kind: "Assistant", text: contentText(message.content) || message.stopReason };
    if (message.role === "toolResult") return { kind: "Tool result", text: contentText(message.content) };
    if (message.role === "bashExecution") return { kind: "Shell", text: message.command };
    return { kind: message.role, text: contentText("content" in message ? message.content : "") };
  }
  if (entry.type === "compaction") return { kind: "Compaction", text: entry.summary };
  if (entry.type === "branch_summary") return { kind: "Branch summary", text: entry.summary };
  if (entry.type === "custom_message") return { kind: entry.customType, text: contentText(entry.content) };
  if (entry.type === "thinking_level_change") return { kind: "Thinking", text: entry.thinkingLevel };
  if (entry.type === "model_change") return { kind: "Model", text: `${entry.provider}/${entry.modelId}` };
  if (entry.type === "session_info") return { kind: "Session", text: entry.name ?? "Session metadata" };
  return { kind: entry.type.replaceAll("_", " "), text: "" };
}

function labelTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const time = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function activePathFor(roots: readonly SessionTreeNode[], leafId: string | null): Set<string> {
  const parentById = new Map<string, string | null>();
  const stack = [...roots];
  while (stack.length) {
    const node = stack.pop()!;
    parentById.set(node.entry.id, node.entry.parentId);
    stack.push(...node.children);
  }
  const activePath = new Set<string>();
  for (let id: string | null = leafId; id; id = parentById.get(id) ?? null) activePath.add(id);
  return activePath;
}

function projectVisible(nodes: readonly SessionTreeNode[], leafId: string | null, activePath: ReadonlySet<string>, filter: TreeFilterMode, query: string): VisibleTreeNode[] {
  const result: VisibleTreeNode[] = [];
  const ordered = [...nodes].sort((a, b) => Number(activePath.has(b.entry.id)) - Number(activePath.has(a.entry.id)));
  for (const node of ordered) {
    const children = projectVisible(node.children, leafId, activePath, filter, query);
    if (visibleEntry(node, node.entry.id === leafId, filter, query)) result.push({ node, children });
    else result.push(...children);
  }
  return result;
}

function flattenTree(roots: readonly SessionTreeNode[], leafId: string | null, filter: TreeFilterMode, query: string): FlatTreeEntry[] {
  const activePath = activePathFor(roots, leafId);
  const visibleRoots = projectVisible(roots, leafId, activePath, filter, query);
  const result: FlatTreeEntry[] = [];
  const visit = (item: VisibleTreeNode, lane: number, parentLane: number | null, continuationLanes: number[]): void => {
    result.push({ node: item.node, lane, parentLane, continuationLanes, hasChildren: item.children.length > 0, onActivePath: activePath.has(item.node.entry.id) });
    const branching = item.children.length > 1;
    const childLane = branching ? lane + 1 : lane;
    item.children.forEach((child, index) => {
      const childContinuations = branching && index < item.children.length - 1 ? [...continuationLanes, lane] : continuationLanes;
      visit(child, childLane, lane, childContinuations);
    });
  };
  visibleRoots.forEach((root) => visit(root, 0, null, []));
  return result;
}

function renderTreeRibbon(entry: FlatTreeEntry): string {
  const width = (Math.max(entry.lane, entry.parentLane ?? 0, ...entry.continuationLanes) + 1) * 18;
  const x = entry.lane * 18 + 9;
  const parentX = (entry.parentLane ?? entry.lane) * 18 + 9;
  const continuations = [...new Set(entry.continuationLanes)].map((lane) => `<path class="agent-tree-ribbon-continuation" d="M ${lane * 18 + 9} 0 V 48"/>`).join("");
  const incoming = entry.parentLane === null ? "" : entry.parentLane === entry.lane
    ? `<path class="agent-tree-ribbon-connection" d="M ${x} 0 V 24"/>`
    : `<path class="agent-tree-ribbon-connection" d="M ${parentX} 0 C ${parentX} 10, ${x} 10, ${x} 24"/>`;
  const outgoing = entry.hasChildren ? `<path class="agent-tree-ribbon-connection" d="M ${x} 24 V 48"/>` : "";
  return `<svg class="agent-tree-ribbon" style="width:${width}px" viewBox="0 0 ${width} 48" preserveAspectRatio="none" aria-hidden="true">${continuations}${incoming}${outgoing}<circle cx="${x}" cy="24" r="4"/></svg>`;
}

export function renderAgentTreeMenu(tree: readonly SessionTreeNode[], leafId: string | null, options: { filter?: TreeFilterMode; query?: string } = {}): string {
  const filter = options.filter ?? "default";
  const query = options.query?.trim() ?? "";
  const entries = flattenTree(tree, leafId, filter, query);
  const controls = `<header class="agent-tree-header"><span class="agent-tree-heading"><b>Session tree</b><span>Select a point to continue from</span></span><span class="agent-tree-controls"><input class="agent-tree-search text-field" type="search" value="${escapeHtml(query)}" placeholder="Search entries…" aria-label="Search session tree"><select class="agent-tree-filter" aria-label="Filter session tree">${treeFilterOptions.map(([value, label]) => `<option value="${value}"${filter === value ? " selected" : ""}>${label}</option>`).join("")}</select></span></header>`;
  const rows = entries.length === 0 ? `<div class="agent-completion-menu empty">No matching entries</div>` : entries.map((entry) => {
    const { node, lane } = entry;
    const current = node.entry.id === leafId;
    const view = entryView(node.entry);
    const label = parseTreeLabels(node.label).map((value) => `<span class="agent-tree-label"><span>${escapeHtml(value)}</span><span class="agent-tree-label-remove" role="button" aria-label="Remove label ${escapeHtml(value)}" title="Remove label" data-tree-action="label-remove" data-tree-label="${escapeHtml(value)}">×</span></span>`).join("");
    const labelTimestamp = node.labelTimestamp && label ? `<span class="agent-tree-label-time">${escapeHtml(labelTime(node.labelTimestamp))}</span>` : "";
    return `<div class="agent-tree-row" data-tree-entry="${escapeHtml(node.entry.id)}" style="--tree-lane:${lane}">
      <button type="button" class="agent-completion-option action-item action-item__primary agent-tree-option${current ? " active" : ""}${entry.onActivePath ? " on-active-path" : ""}" role="option" aria-selected="${current}" data-completion-kind="tree-entry" data-tree-entry="${escapeHtml(node.entry.id)}">
        ${renderTreeRibbon(entry)}
        <span class="agent-tree-copy"><span class="agent-tree-meta"><b>${escapeHtml(view.kind)}</b>${label}${labelTimestamp}${current ? `<span class="agent-tree-current">current</span>` : ""}</span><span class="agent-tree-text">${escapeHtml(view.text.trim().replace(/\s+/g, " ") || "(no text)")}</span></span>
      </button>
      <span class="agent-tree-label-editor" hidden><input class="text-field" type="text" value="" placeholder="Add a label" aria-label="New node label"><button class="button" type="button" data-tree-action="label-cancel">Cancel</button><button type="button" class="button primary" data-tree-action="label-save">Add</button></span>
    </div>`;
  }).join("");
  return `<div class="agent-completion-menu action-list agent-tree-menu" role="listbox" aria-label="Session tree">${controls}${rows}</div>`;
}

export function renderAgentSessionTree(manager: SessionManager, options: { filter: TreeFilterMode; query: string }): string {
  let leafId = manager.getLeafId();
  while (leafId && manager.getEntry(leafId)?.type === "label") leafId = manager.getEntry(leafId)?.parentId ?? null;
  return renderAgentTreeMenu(manager.getTree(), leafId, options);
}

export function updateAgentSessionTreeLabel(manager: SessionManager, entryId: string, label: string, operation: "add" | "remove"): void {
  if (!manager.getEntry(entryId)) throw new Error("Tree entry no longer exists.");
  const value = label.trim();
  const labels = parseTreeLabels(manager.getLabel(entryId));
  const next = operation === "add" ? [...labels.filter((candidate) => candidate !== value), value] : labels.filter((candidate) => candidate !== value);
  manager.appendLabelChange(entryId, serializeTreeLabels(next));
}

export function renderAgentTreeSummaryMenu(entryId: string): string {
  return `<div class="agent-completion-menu agent-tree-summary-menu" role="listbox" aria-label="Branch summary choice" data-tree-entry="${escapeHtml(entryId)}">
    <header class="agent-tree-header"><span class="agent-tree-heading"><b>Continue from this point</b><span>What should happen to the branch you’re leaving?</span></span></header>
    <div class="agent-tree-summary-choices action-list">
      <button type="button" class="agent-completion-option action-item action-item__primary agent-tree-summary-option active" role="option" aria-selected="true" data-completion-kind="tree-summary" data-summary-mode="none"><b>No summary</b><span>Switch state without carrying anything forward.</span></button>
      <button type="button" class="agent-completion-option action-item action-item__primary agent-tree-summary-option" role="option" aria-selected="false" data-completion-kind="tree-summary" data-summary-mode="summary"><b>Summarize</b><span>Ask the agent to preserve useful context from the branch.</span></button>
      <button type="button" class="agent-completion-option action-item action-item__primary agent-tree-summary-option" role="option" aria-selected="false" data-completion-kind="tree-summary" data-summary-mode="custom"><b>Summarize with additional instructions</b><span>Add guidance for what the summary should retain.</span></button>
    </div>
    <div class="agent-tree-custom" hidden>
      <label for="agent-tree-custom-instructions">Additional summary instructions</label>
      <textarea class="textarea" id="agent-tree-custom-instructions" rows="3" placeholder="For example: preserve the API decisions and unresolved risks."></textarea>
      <div><button type="button" class="button" data-completion-kind="tree-summary-back">Back</button><button type="button" class="button primary" data-completion-kind="tree-summary-confirm">Summarize and continue</button></div>
    </div>
  </div>`;
}

interface AgentTreeRuntime {
  treeHtml(options: { filter: TreeFilterMode; query: string }): string;
  labelTreeEntry(entryId: string, label: string, operation: "add" | "remove"): void;
  navigateTree(entryId: string, options: { summarize: boolean; customInstructions?: string }): Promise<string>;
}

export async function handleAgentTreeRequest(request: Request, url: URL, suffix: string, runtime: () => Promise<AgentTreeRuntime>): Promise<Response | undefined> {
  if (suffix === "/summary" && request.method === "GET") {
    const entry = url.searchParams.get("entry") ?? "";
    if (!entry) throw new AtelierCoreError("invalid_arguments", "tree entry is required");
    return new Response(renderAgentTreeSummaryMenu(entry), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (suffix === "/label" && request.method === "POST") {
    const form = await request.formData();
    const entry = String(form.get("entry") ?? "");
    const label = String(form.get("label") ?? "");
    const operation = form.get("operation");
    if (!entry || !label.trim() || (operation !== "add" && operation !== "remove")) throw new AtelierCoreError("invalid_arguments", "tree entry, label, and valid operation are required");
    (await runtime()).labelTreeEntry(entry, label, operation);
    return new Response(null, { status: 204 });
  }
  if (suffix === "" && request.method === "GET") {
    const html = (await runtime()).treeHtml({ filter: parseTreeFilterMode(url.searchParams.get("filter")), query: url.searchParams.get("q") ?? "" });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (suffix === "" && request.method === "POST") {
    const form = await request.formData();
    const entry = String(form.get("entry") ?? "");
    if (!entry) throw new AtelierCoreError("invalid_arguments", "tree entry is required");
    const summaryMode = String(form.get("summaryMode") ?? "none");
    if (summaryMode !== "none" && summaryMode !== "summary" && summaryMode !== "custom") throw new AtelierCoreError("invalid_arguments", "valid summary mode is required");
    const editorText = await (await runtime()).navigateTree(entry, {
      summarize: summaryMode !== "none",
      customInstructions: summaryMode === "custom" ? String(form.get("customInstructions") ?? "") : undefined,
    });
    return new Response(editorText, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return undefined;
}
