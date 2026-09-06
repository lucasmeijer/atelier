import { Type } from "typebox";
import { Value } from "typebox/value";
import { CableTopics, type CableSubscription, type WorkspaceClientControllerConstructor } from "@atelier/shared";
type Frame = HTMLElement & { src: string };

export function createSubagentsController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["frame", "branch"];
    static values = { url: String, workspaceId: String };
    declare readonly element: HTMLElement;
    declare readonly frameTarget: Frame;
    declare readonly branchTargets: HTMLDetailsElement[];
    declare readonly urlValue: string;
    declare readonly workspaceIdValue: string;
    private parentId?: string;
    private tree?: CableSubscription;
    private children = new Map<string, { branch: HTMLDetailsElement; subscription: CableSubscription }>();
    private expanded = new Set<string>();
    private reveal?: string;
    private message?: string;
    private get storageKey(): string { return `atelier:subagents:${this.urlValue}:${this.parentId}`; }

    connect(): void { this.sync(); }
    disconnect(): void { this.stop(); }
    private stop(): void {
      this.tree?.unsubscribe();
      this.tree = undefined;
      for (const child of this.children.values()) child.subscription.unsubscribe();
      this.children.clear();
    }
    sync(): void {
      const workspace = this.element.closest("[data-controller~='workspace-presentation']")!;
      const id = workspace.querySelector<HTMLElement>("[data-workspace-pane-role='agent'].is-active")?.dataset.workspacePaneId;
      if (id !== this.parentId) {
        this.stop();
        this.parentId = id;
        const stored: unknown = JSON.parse(sessionStorage.getItem(this.storageKey) ?? "[]");
        this.expanded = new Set(Value.Check(Type.Array(Type.String()), stored) ? stored : []);
        const params = new URL(location.href).searchParams;
        this.reveal = params.get("agent") === id ? params.get("subagent") ?? undefined : undefined;
        this.message = params.get("message") ?? undefined;
      }
      if (!id || document.hidden || !this.element.checkVisibility()) { this.stop(); return; }
      if (!this.tree) {
        this.tree = window.AtelierCable!.subscribe(CableTopics.subagents(this.workspaceIdValue, id), {
          onReady: () => this.restore(),
          onDisconnected: () => {
            for (const child of this.children.values()) child.subscription.unsubscribe();
            this.children.clear();
          },
        });
      }
    }
    private restore(): void {
      if (this.reveal) {
        let branch = this.branchTargets.find((branch) => branch.dataset.subagentId === this.reveal);
        while (branch) {
          this.expanded.add(branch.dataset.subagentId!);
          branch = branch.parentElement!.closest<HTMLDetailsElement>(".subagent-branch") ?? undefined;
        }
      }
      for (const branch of this.branchTargets) branch.open = this.expanded.has(branch.dataset.subagentId!);
      this.syncChildren();
    }
    branchTargetConnected(): void { if (this.tree) this.restore(); }
    branchTargetDisconnected(branch: HTMLDetailsElement): void {
      const id = branch.dataset.subagentId!;
      const child = this.children.get(id);
      if (child?.branch === branch) { child.subscription.unsubscribe(); this.children.delete(id); }
    }
    private syncChildren(): void {
      for (const branch of this.branchTargets) {
        const id = branch.dataset.subagentId!;
        const visible = this.tree && branch.open && !branch.parentElement!.closest(".subagent-branch:not([open])");
        const child = this.children.get(id);
        if (!visible) { child?.subscription.unsubscribe(); this.children.delete(id); continue; }
        if (child?.branch === branch) continue;
        child?.subscription.unsubscribe();
        const subscription = window.AtelierCable!.subscribe(CableTopics.agent(this.workspaceIdValue, id), {
          onReady: () => {
            if (this.reveal === id && this.message) {
              const frame = branch.querySelector<Frame>(":scope > .subagent-branch-body > [data-subagent-transcript]")!;
              frame.src = `${this.urlValue}/${encodeURIComponent(id)}/transcript?agent=${encodeURIComponent(this.parentId!)}&message=${encodeURIComponent(this.message)}`;
            } else this.loaded();
          },
        });
        this.children.set(id, { branch, subscription });
      }
    }
    toggle(event: Event): void {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !details.dataset.subagentId) return;
      if (details.open) this.expanded.add(details.dataset.subagentId);
      else this.expanded.delete(details.dataset.subagentId);
      sessionStorage.setItem(this.storageKey, JSON.stringify([...this.expanded]));
      this.syncChildren();
    }
    loaded(): void {
      if (!this.reveal) return;
      const branch = this.branchTargets.find((branch) => branch.dataset.subagentId === this.reveal);
      if (!branch) return;
      const target = this.message ? branch.querySelector<HTMLElement>(`[data-communication-id="${CSS.escape(this.message)}"]`) : branch;
      if (target) {
        if (target instanceof HTMLDetailsElement) target.open = true;
        target.scrollIntoView({ block: "center" });
        this.reveal = undefined;
      }
    }
  };
}
