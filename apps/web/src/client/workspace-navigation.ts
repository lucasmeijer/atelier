import { Controller } from "@hotwired/stimulus";
import { recentWorkspaceProjectStorageKey } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { cableRequestHeaders } from "./workspace-cable.ts";
import { markActiveWorkspaceRow } from "./workspace-presentation.ts";
import { registerWorkspaceControllers, residencyController } from "./workspace-controller-registry.ts";

const projectDisclosuresSchema = Type.Record(Type.String(), Type.Boolean());

class EmptyWorkspaceOnboardingController extends Controller<HTMLElement> {
  static targets = ["origin", "svg", "path"];
  static values = { destination: String };

  declare readonly originTarget: HTMLElement;
  declare readonly svgTarget: SVGSVGElement;
  declare readonly pathTarget: SVGPathElement;
  declare readonly destinationValue: "first-project" | "first-workspace";

  private observer: MutationObserver | undefined;

  connect(): void {
    window.addEventListener("resize", this.draw);
    const empty = this.element.closest(".workspace-detail-empty")!;
    this.observer = new MutationObserver(this.draw);
    this.observer.observe(empty, { attributes: true, attributeFilter: ["hidden"] });
    this.observer.observe(this.element.closest(".fixed-shell-app")!, { attributes: true, attributeFilter: ["class"] });
    requestAnimationFrame(this.draw);
  }

  disconnect(): void {
    window.removeEventListener("resize", this.draw);
    this.observer?.disconnect();
  }

  private draw = (): void => {
    const origin = this.originTarget.getBoundingClientRect();
    if (origin.width === 0) return;
    const start = { x: origin.left + origin.width / 2, y: origin.bottom + 12 };
    const destination = document.querySelector<HTMLElement>(`[data-empty-workspace-onboarding-destination="${this.destinationValue}"]`)!.getBoundingClientRect();
    const end = { x: destination.right + 5, y: destination.top + destination.height / 2 };
    const horizontalDirection = end.x >= start.x ? 1 : -1;
    const horizontalBend = Math.min(180, Math.max(40, Math.abs(end.x - start.x) * 0.7));
    const verticalBend = Math.min(150, Math.max(70, Math.abs(end.y - start.y) * 0.45));
    this.svgTarget.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    this.pathTarget.setAttribute("d", `M ${start.x} ${start.y} C ${start.x} ${start.y + verticalBend}, ${end.x - horizontalDirection * horizontalBend} ${end.y}, ${end.x} ${end.y}`);
  };
}

class WorkspaceNavigationController extends Controller<HTMLElement> {
  static targets = ["scroll"];
  declare readonly scrollTarget: HTMLElement;
  private scrollTimer?: ReturnType<typeof setTimeout>;

  connect(): void {
    this.scrollTarget.addEventListener("scroll", this.scrolled, { passive: true });
    this.element.addEventListener("atelier:mobile-resident-destination-selected", this.mobileResidentDestinationSelected);
    document.addEventListener("atelier:workspace-pane-changed", this.workspacePaneChanged);
    const scroll = Number(localStorage.getItem("atelier:workspace-pane-scroll"));
    if (Number.isFinite(scroll)) this.scrollTarget.scrollTop = scroll;
    this.restoreProjectDisclosures();
    this.setWorkspacePaneOpen(!this.element.querySelector(".workspace-detail-resident.visible"));
    this.setWorkspacePaneCollapsed(sessionStorage.getItem("atelier:workspace-pane-collapsed") === "true" && Boolean(this.visibleWorkspacePaneToggle()));
  }

  disconnect(): void {
    this.scrollTarget.removeEventListener("scroll", this.scrolled);
    this.element.removeEventListener("atelier:mobile-resident-destination-selected", this.mobileResidentDestinationSelected);
    document.removeEventListener("atelier:workspace-pane-changed", this.workspacePaneChanged);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
  }

  closeWorkspacePane(): void {
    this.setWorkspacePaneOpen(false);
    this.element.querySelector<HTMLElement>(".workspace-detail-resident.visible [data-show-workspace-list]")!.focus();
  }

  showWorkspacePane(): void {
    this.setWorkspacePaneOpen(true);
  }

  toggleWorkspacePaneCollapsed(): void {
    const collapsed = !this.element.classList.contains("is-workspace-pane-collapsed");
    const toggle = collapsed
      ? this.visibleWorkspacePaneToggle()
      : this.element.querySelector<HTMLButtonElement>("[data-collapse-workspace-pane]");
    if (!toggle) return;
    this.setWorkspacePaneCollapsed(collapsed);
    requestAnimationFrame(() => toggle.focus());
  }

  private setWorkspacePaneCollapsed(collapsed: boolean): void {
    this.element.classList.toggle("is-workspace-pane-collapsed", collapsed);
    sessionStorage.setItem("atelier:workspace-pane-collapsed", String(collapsed));
  }

  private visibleWorkspacePaneToggle(): HTMLButtonElement | null {
    return this.element.querySelector<HTMLButtonElement>(".workspace-detail-resident.visible [data-show-workspace-pane]");
  }

  private setWorkspacePaneOpen(open: boolean): void {
    this.element.classList.toggle("is-mobile-workspace-pane-open", open);
  }

  private readonly mobileResidentDestinationSelected = (): void => this.setWorkspacePaneOpen(false);
  private readonly workspacePaneChanged = (): void => {
    this.restoreProjectDisclosures();
    const workspaceId = residencyController()?.visibleWorkspaceId();
    if (workspaceId) this.setActiveWorkspace(workspaceId);
  };

  async selectWorkspace(event: Event): Promise<void> {
    // SAFETY: This action is attached only to server-rendered Workspace entry elements.
    const workspaceId = (event.currentTarget as HTMLElement).dataset.workspaceEntryId;
    if (workspaceId) await this.selectWorkspaceById(workspaceId);
  }

  async selectWorkspaceById(workspaceId: string): Promise<void> {
    this.setWorkspacePaneOpen(false);
    this.expandWorkspaceGroupsContaining(workspaceId);
    this.setActiveWorkspace(workspaceId);
    await residencyController()?.selectWorkspace(workspaceId, `/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  workspaceDeletionStarted(event: Event): void {
    // SAFETY: This action is attached only to server-rendered workspace deletion forms.
    const form = event.currentTarget as HTMLFormElement;
    const workspaceId = form.closest<HTMLElement>(".workspace-detail-resident")!.dataset.workspaceId!;
    residencyController()?.unselectWorkspace(workspaceId);
  }

  async parkWorkspace(event: Event): Promise<void> {
    event.preventDefault();
    // SAFETY: This action is attached only to the server-rendered Agent-pane park form.
    const form = event.currentTarget as HTMLFormElement;
    await this.submitParkedState(form);
  }

  async unparkWorkspace(event: Event): Promise<void> {
    event.preventDefault();
    // SAFETY: This action is attached only to server-rendered unpark forms.
    const form = event.currentTarget as HTMLFormElement;
    const workspaceId = form.dataset.workspaceEntryId!;
    await this.submitParkedState(form);
    await this.selectWorkspaceById(workspaceId);
  }

  private async submitParkedState(form: HTMLFormElement): Promise<void> {
    const button = form.querySelector<HTMLButtonElement>("button[type='submit']")!;
    button.disabled = true;
    const response = await fetch(form.action, {
      method: "POST",
      headers: cableRequestHeaders({ Accept: "text/vnd.turbo-stream.html" }),
    });
    if (!response.ok) throw new Error(`Could not update parked workspace: HTTP ${response.status}`);
    const html = await response.text();
    if (html) window.Turbo?.renderStreamMessage(html);
  }

  toggleProject(event: Event): void {
    // SAFETY: This action is attached only to server-rendered Project disclosure buttons.
    const button = event.currentTarget as HTMLElement;
    const id = button.dataset.projectId;
    if (!id) return;
    const project = this.element.querySelector<HTMLElement>(`.fixed-shell-project[data-project-id="${CSS.escape(id)}"]`)!;
    const expanded = project.classList.contains("is-collapsed");
    project.classList.toggle("is-collapsed", !expanded);
    button.setAttribute("aria-expanded", String(expanded));
    const disclosures = this.projectDisclosures();
    disclosures[id] = expanded;
    localStorage.setItem("atelier:workspace-project-disclosures", JSON.stringify(disclosures));
  }

  setActiveWorkspace(workspaceId: string): void {
    markActiveWorkspaceRow(this.element, workspaceId);
    const row = this.element.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    localStorage.setItem(recentWorkspaceProjectStorageKey, row?.dataset.projectId ?? "");
  }

  private expandWorkspaceGroupsContaining(workspaceId: string): void {
    const row = this.element.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    if (!row) return;

    const disclosures = this.projectDisclosures();
    let group = row.closest<HTMLElement>(".fixed-shell-project[data-project-id]");
    while (group) {
      group.classList.remove("is-collapsed");
      group.querySelector<HTMLElement>(":scope > .action-item [data-project-id][aria-expanded]")?.setAttribute("aria-expanded", "true");
      disclosures[group.dataset.projectId!] = true;
      group = group.parentElement?.closest<HTMLElement>(".fixed-shell-project[data-project-id]") ?? null;
    }
    localStorage.setItem("atelier:workspace-project-disclosures", JSON.stringify(disclosures));
  }

  private restoreProjectDisclosures(): void {
    const disclosures = this.projectDisclosures();
    this.element.querySelectorAll<HTMLElement>(".fixed-shell-project[data-project-id]").forEach((project) => {
      const onboardingTarget = project.querySelector('[data-empty-workspace-onboarding-destination="first-workspace"]');
      const id = project.dataset.projectId!;
      if (!(id in disclosures) && !onboardingTarget) return;
      const expanded = onboardingTarget ? true : disclosures[id]!;
      project.classList.toggle("is-collapsed", !expanded);
      project.querySelector<HTMLElement>("[data-project-id][aria-expanded]")?.setAttribute("aria-expanded", String(expanded));
    });
  }

  private projectDisclosures(): Record<string, boolean> {
    const text = localStorage.getItem("atelier:workspace-project-disclosures");
    return text ? Value.Parse(projectDisclosuresSchema, JSON.parse(text)) : {};
  }

  private scrolled = (): void => {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => localStorage.setItem("atelier:workspace-pane-scroll", String(this.scrollTarget.scrollTop)), 80);
  };
}

export function registerWorkspaceNavigationControllers(): void {
  registerWorkspaceControllers({
    "empty-workspace-onboarding": EmptyWorkspaceOnboardingController,
    "workspace-navigation": WorkspaceNavigationController,
  });
}
