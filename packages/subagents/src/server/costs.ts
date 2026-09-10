import { parseSessionEntries, type FileEntry } from "@earendil-works/pi-coding-agent";
import { inheritedContextEntryType } from "./fork-history.ts";

/** Copied usage describes the parent's spending, not the child's input charge. */
export function ownSessionCost(entries: readonly FileEntry[]): number {
  const boundary = entries.findIndex((entry) => entry.type === "custom" && entry.customType === inheritedContextEntryType);
  let cost = 0;
  for (const entry of entries.slice(boundary + 1)) {
    if (entry.type === "compaction" || entry.type === "branch_summary") cost += entry.usage?.cost.total ?? 0;
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) cost += entry.message.usage?.cost.total ?? 0;
  }
  return cost;
}

type Agent = { id: string; parentId: string };

/** Completed-turn totals only. Historical sessions are read once, without loading inference runtimes. */
export class SubagentCosts {
  private own = new Map<string, number>();
  private loading = new Map<string, Promise<void>>();
  private listeners = new Map<string, Set<() => void>>();

  constructor(private agents: () => readonly Agent[], private path: (id: string) => Promise<string>) {}

  update(id: string, entries: readonly FileEntry[]): void {
    this.own.set(id, ownSessionCost(entries));
    let current: string | undefined = id;
    while (current) {
      for (const listener of this.listeners.get(current) ?? []) listener();
      current = this.agents().find((agent) => agent.id === current)?.parentId;
    }
  }

  subscribe(id: string, listener: () => void): () => void {
    let listeners = this.listeners.get(id);
    if (!listeners) this.listeners.set(id, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }

  private async load(id: string): Promise<void> {
    if (this.own.has(id)) return;
    let loading = this.loading.get(id);
    if (!loading) {
      loading = (async () => {
        const path = await this.path(id);
        // A recorded child may not have created its session yet.
        const file = Bun.file(path);
        const cost = await file.exists() ? ownSessionCost(parseSessionEntries(await file.text())) : 0;
        if (!this.own.has(id)) this.own.set(id, cost);
      })();
      this.loading.set(id, loading);
    }
    try { await loading; } finally { this.loading.delete(id); }
  }

  async snapshot(id: string): Promise<{ cost: number; descendantCost?: number; isSubagent: boolean }> {
    const children = new Map<string, string[]>();
    for (const agent of this.agents()) {
      const siblings = children.get(agent.parentId) ?? [];
      siblings.push(agent.id);
      children.set(agent.parentId, siblings);
    }
    const descendants: string[] = [];
    const visit = (parent: string): void => {
      for (const child of children.get(parent) ?? []) { descendants.push(child); visit(child); }
    };
    visit(id);
    await Promise.all(descendants.map((child) => this.load(child)));
    return {
      cost: this.own.get(id)!,
      descendantCost: descendants.length ? descendants.reduce((sum, child) => sum + this.own.get(child)!, 0) : undefined,
      isSubagent: this.agents().some((agent) => agent.id === id),
    };
  }
}
