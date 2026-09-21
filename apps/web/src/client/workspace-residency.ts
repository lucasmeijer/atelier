import { phoneLayoutMediaQuery } from "@atelier/shared";
import { Controller } from "@hotwired/stimulus";
import { liveSurfaceReady, prepareLiveSurface, releaseLiveSurface } from "./live-surface.ts";
import { controllerForElement, registerWorkspaceControllers, workspaceNavigationController } from "./workspace-controller-registry.ts";

interface ResidentPresentation {
  prepareIntendedSurfaces(): Promise<void>;
  intendedSurfacesReady(): boolean;
}

class WorkspaceResidencyController extends Controller<HTMLElement> {
  static targets = ["resident", "empty", "loading"];
  static values = { maxResident: Number };
  declare readonly residentTargets: HTMLElement[];
  declare readonly emptyTargets: HTMLElement[];
  declare readonly loadingTargets: HTMLElement[];
  declare readonly maxResidentValue: number;
  private intended?: string;
  private selection = 0;
  private readonly preparing = new Set<HTMLElement>();
  private retained = new Set<HTMLElement>();

  connect(): void {
    document.addEventListener("atelier:workspace-pane-changed", this.changed);
    this.element.addEventListener("live:ready", this.changed);
    document.addEventListener("live:connection", this.changed);
    document.addEventListener("atelier:workspace-pane-visible", this.reportVisibility);
    document.addEventListener("atelier:workspace-pane-hidden", this.reportVisibility);
    document.addEventListener("visibilitychange", this.reportVisibility);
    document.addEventListener("atelier:mobile-workspace-pane-changed", this.reportVisibility);
    window.addEventListener("popstate", this.historyChanged);
    this.historyChanged();
  }
  disconnect(): void {
    this.selection++;
    document.removeEventListener("atelier:workspace-pane-changed", this.changed);
    this.element.removeEventListener("live:ready", this.changed);
    document.removeEventListener("live:connection", this.changed);
    document.removeEventListener("atelier:workspace-pane-visible", this.reportVisibility);
    document.removeEventListener("atelier:workspace-pane-hidden", this.reportVisibility);
    document.removeEventListener("visibilitychange", this.reportVisibility);
    document.removeEventListener("atelier:mobile-workspace-pane-changed", this.reportVisibility);
    window.removeEventListener("popstate", this.historyChanged);
    window.AtelierCable?.reportVisibility({ surfaceKeys: [] });
  }
  residentTargetConnected(resident: HTMLElement): void {
    if (resident.dataset.workspaceId === this.intended && !resident.classList.contains("visible")) void this.selectWorkspace(this.intended!, location.href, "none");
  }
  residentTargetDisconnected(resident: HTMLElement): void {
    if (resident.dataset.workspaceId === this.intended) this.unselectWorkspace(this.intended!);
    this.reportVisibility();
  }
  async selectWorkspace(workspaceId: string, href: string, historyMode: "push" | "none" = "push"): Promise<void> {
    const selection = ++this.selection;
    this.intended = workspaceId;
    if (historyMode === "push" && new URL(href, location.href).href !== location.href) history.pushState({}, "", href);
    workspaceNavigationController()?.setActiveWorkspace(workspaceId);
    const resident = this.residentTargets.find(item => item.dataset.workspaceId === workspaceId);
    // A command acknowledgement can precede the shell snapshot containing its mount.
    if (!resident) return;
    this.hideResidents();
    this.emptyTargets.forEach(element => { element.hidden = true; });
    this.loadingTargets.forEach(element => { element.hidden = true; });
    resident.classList.add("visible");
    resident.dataset.lastActivatedAt = String(Date.now());
    await prepareLiveSurface(resident);
    if (selection !== this.selection) return;
    const presentation = resident.querySelector<HTMLElement>("[data-controller~='workspace-presentation']");
    presentation?.dispatchEvent(new Event("atelier:workspace-residency-visible"));
    if (presentation) await controllerForElement<{ prepareIntendedSurfaces(): Promise<void> }>(presentation, "workspace-presentation")?.prepareIntendedSurfaces();
    this.changed();
    this.reportVisibility();

  }
  unselectWorkspace(workspaceId: string): void {
    if (this.intended !== workspaceId) return;
    this.selection++;
    this.intended = undefined;
    history.replaceState({}, "", "/");
    this.hideResidents();
    this.emptyTargets.forEach(element => { element.hidden = false; });
    this.changed();
    this.reportVisibility();
  }
  visibleWorkspaceId(): string | undefined { return this.residentTargets.find(item => item.classList.contains("visible"))?.dataset.workspaceId; }
  oldestAttentionWorkspaceId(): string | undefined {
    return [...document.querySelectorAll<HTMLElement>("[data-workspace-entry-id][data-workspace-attention-at]")]
      .sort((a, b) => Number(a.dataset.workspaceAttentionAt) - Number(b.dataset.workspaceAttentionAt))[0]?.dataset.workspaceEntryId;
  }
  private hideResidents(): void {
    for (const resident of this.residentTargets) {
      if (resident.classList.contains("visible")) resident.querySelector("[data-controller~='workspace-presentation']")?.dispatchEvent(new Event("atelier:workspace-residency-hidden"));
      resident.classList.remove("visible");
    }
  }
  private presentation(resident: HTMLElement): ResidentPresentation | undefined {
    const element = resident.querySelector<HTMLElement>("[data-controller~='workspace-presentation']");
    return element ? controllerForElement<ResidentPresentation>(element, "workspace-presentation") ?? undefined : undefined;
  }
  private prepared(resident: HTMLElement): boolean {
    return liveSurfaceReady(resident) && (this.presentation(resident)?.intendedSurfacesReady() ?? false);
  }
  private maintainResidents(): void {
    const attention = new Map([...document.querySelectorAll<HTMLElement>("[data-workspace-entry-id][data-workspace-attention-at]")]
      .map(row => [row.dataset.workspaceEntryId!, Number(row.dataset.workspaceAttentionAt)]));
    const candidates = this.residentTargets.filter(resident => resident.classList.contains("visible") || resident.childElementCount || attention.has(resident.dataset.workspaceId!));
    candidates.sort((a, b) => Number(b.classList.contains("visible")) - Number(a.classList.contains("visible"))
      || (attention.get(a.dataset.workspaceId!) ?? Infinity) - (attention.get(b.dataset.workspaceId!) ?? Infinity)
      || Number(b.dataset.lastActivatedAt ?? 0) - Number(a.dataset.lastActivatedAt ?? 0));
    this.retained = new Set(candidates.slice(0, this.maxResidentValue));
    for (const resident of candidates) {
      if (!this.retained.has(resident)) { releaseLiveSurface(resident); continue; }
      if (this.prepared(resident) || this.preparing.has(resident)) continue;
      this.preparing.add(resident);
      void (async () => {
        await prepareLiveSurface(resident);
        if (!resident.isConnected || !this.retained.has(resident)) return;
        await this.presentation(resident)?.prepareIntendedSurfaces();
      })().finally(() => { this.preparing.delete(resident); this.updateRows(); });
    }
  }
  private readonly changed = (): void => {
    this.maintainResidents();
    this.updateRows();
  };
  private updateRows(): void {
    const active = this.visibleWorkspaceId();
    document.querySelectorAll<HTMLElement>("[data-workspace-entry-id]").forEach(row => {
      if (row.dataset.workspaceEntryId === active) row.setAttribute("aria-current", "page");
      else row.removeAttribute("aria-current");
      const resident = this.residentTargets.find(item => item.dataset.workspaceId === row.dataset.workspaceEntryId);
      row.dataset.workspacePreloadState = resident && this.prepared(resident) ? "preloaded" : "unloaded";
    });
    const next = document.querySelector<HTMLButtonElement>("#fixed_shell_atelier_next_attention");
    if (next) next.disabled = this.oldestAttentionWorkspaceId() === undefined;
    const close = document.querySelector<HTMLButtonElement>("[data-close-workspace-pane]");
    if (close) close.disabled = active === undefined;
  }
  private readonly reportVisibility = (): void => {
    const workspaceId = this.visibleWorkspaceId();
    const hidden = document.hidden || (window.matchMedia(phoneLayoutMediaQuery).matches && this.element.closest(".is-mobile-workspace-pane-open") !== null);
    const resident = this.residentTargets.find(item => item.dataset.workspaceId === workspaceId);
    const surfaceKeys = !hidden && resident ? [...resident.querySelectorAll<HTMLElement>('[data-workspace-surface-visible="true"]')].map(pane => `${pane.dataset.workspacePaneRole === "agent" ? "agent:" : ""}${pane.dataset.workspacePaneId}`) : [];
    window.AtelierCable?.reportVisibility({ workspaceId: hidden ? undefined : workspaceId, surfaceKeys });
  };
  private readonly historyChanged = (): void => {
    const id = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
    if (id) void this.selectWorkspace(decodeURIComponent(id), location.href, "none");
    else if (this.intended) this.unselectWorkspace(this.intended);
  };
}
export function registerWorkspaceResidencyController(): void { registerWorkspaceControllers({ "workspace-residency": WorkspaceResidencyController }); }
