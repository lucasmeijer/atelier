import { CableTopics, type CableSubscription } from "@atelier/shared";
import { Controller } from "@hotwired/stimulus";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

const mounts = new WeakMap<HTMLElement, LiveSurfaceController>();

class LiveSurfaceController extends Controller<HTMLElement> {
  static values = { workspace: String, kind: String, key: String, eager: Boolean, agent: String, work: String };
  declare readonly workspaceValue: string;
  declare readonly kindValue: string;
  declare readonly keyValue: string;
  declare readonly eagerValue: boolean;
  declare agentValue: string;
  declare workValue: string;
  private subscription?: CableSubscription;
  private pending?: ReturnType<typeof Promise.withResolvers<void>>;
  ready = false;

  connect(): void {
    mounts.set(this.element, this);
    if (this.eagerValue) void this.ensureReady();
  }

  disconnect(): void {
    mounts.delete(this.element);
    this.stop();
  }

  release(): void {
    this.stop();
    this.element.replaceChildren();
  }

  private stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.ready = false;
    this.pending?.resolve();
    this.pending = undefined;
  }

  select(agent: string, work: string): void {
    if (this.kindValue !== "workspace" || (this.agentValue === agent && this.workValue === work)) return;
    this.agentValue = agent;
    this.workValue = work;
    if (!this.subscription) return;
    this.stop();
    void this.ensureReady();
  }

  ensureReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.pending) return this.pending.promise;
    const pending = this.pending = Promise.withResolvers<void>();
    if (this.subscription) return pending.promise;
    const identifier = this.kindValue === "workspace"
      ? CableTopics.module("surface", this.workspaceValue, { kind: this.kindValue, key: this.keyValue, agent: this.agentValue, work: this.workValue })
      : CableTopics.module("surface", this.workspaceValue, { kind: this.kindValue, key: this.keyValue });
    this.subscription = window.AtelierCable!.subscribe(identifier, {
      onReady: () => {
        this.ready = true;
        this.pending?.resolve();
        this.pending = undefined;
        this.element.dispatchEvent(new CustomEvent("live:ready", { bubbles: true }));
      },
      onDisconnected: () => { this.ready = false; },
      onRejected: reason => { this.pending?.reject(new Error(reason)); this.pending = undefined; },
    });
    return pending.promise;
  }
}

export async function prepareLiveSurface(element: HTMLElement): Promise<void> {
  // Newly inserted server HTML connects at Stimulus's next mutation checkpoint.
  if (!mounts.has(element)) await new Promise<void>(resolve => setTimeout(resolve, 0));
  const mount = mounts.get(element);
  if (!mount) throw new Error(`Live surface did not connect: ${element.id}`);
  await mount.ensureReady();
}

export function liveSurfaceReady(element: HTMLElement): boolean { return mounts.get(element)?.ready ?? false; }
export function registerLiveSurfaces(): void { registerWorkspaceControllers({ "live-surface": LiveSurfaceController }); }

export function releaseLiveSurface(element: HTMLElement): void { mounts.get(element)?.release(); }

export function selectLiveSurface(element: HTMLElement, agent: string, work: string): void {
  mounts.get(element)?.select(agent, work);
}
