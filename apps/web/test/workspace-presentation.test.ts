import { describe, expect, test } from "bun:test";
import {
  agentActionsDomId,
  agentBodiesDomId,
  agentBodyFrameId,
  agentNavigationDomId,
  agentPaneSlotDomId,
  agentTabDomId,
  agentTabsTurboStream,
  openWorkViewTurboStream,
  removeWorkspaceResidentTurboStream,
  renderAgentBodyFrame,
  renderWorkspacePane,
  renderWorkspacePresentation,
  renderWorkViewBodyFrame,
  workViewActionsDomId,
  workViewAvailabilityDomId,
  workViewBodyFrameId,
  workViewPaneDomId,
  workViewSelectorDomId,
  workViewsTurboStream,
  type WorkspacePresentation,
} from "../src/server/workspace-presentation.ts";

const firstConversationId = "53fc77b7-dc19-42d5-b200-2e134ec67529";
const secondConversationId = "268604ac-d16a-4a4a-ab1e-1ed3ca54687d";
const agentBodyUrl = (conversationId: string): string => `/workspaces/workspace-1/agents/${conversationId}/body`;

function fixture(overrides: Partial<WorkspacePresentation> = {}): WorkspacePresentation {
  return {
    workspace: { id: "workspace-1", title: "Typed shell" },
    agentConversations: [
      { id: firstConversationId, title: "First", bodyUrl: agentBodyUrl(firstConversationId) },
      { id: secondConversationId, title: "Second", bodyUrl: agentBodyUrl(secondConversationId) },
    ],
    workViews: [
      { key: "terminal:one", label: "Terminal", kind: "resource", availability: { phase: "live" }, bodyHtml: '<div data-probe="terminal">Terminal</div>' },
      { key: "files:workspace", label: "Files", kind: "contextual", attentionSequence: 7, availability: { phase: "reconnecting", detail: "Reconnecting without replacing the listing." }, bodyHtml: '<div data-probe="files">Listing</div>' },
      { key: "browser:preview", label: "Preview", kind: "resource", availability: { phase: "unavailable", detail: "Preview exited.", recoveryHtml: "<button>Retry</button>" }, bodyHtml: "<iframe></iframe>" },
    ],
    ...overrides,
  };
}

describe("role-fixed Workspace presentation", () => {
  test("server-renders fixed roles without selecting personal navigation", () => {
    const html = renderWorkspacePresentation(fixture({ commands: [{ id: "terminal.create", label: "New Terminal", scope: "workspace", placement: "work-launcher" }] }));

    expect(html).toContain('data-controller="workspace-presentation"');
    expect(html).not.toContain('class="fixed-shell-workspace-pane"');
    expect(html).toContain('class="fixed-shell-agent-pane"');
    expect(html).toContain('class="fixed-shell-work-pane"');
    expect(html).not.toContain("workspace-group");
    expect(html).not.toContain("visibleTab");
    expect(html).not.toContain('aria-selected="true"');
    expect(html.match(/data-workspace-pane-role="agent"/g)).toHaveLength(2);
    expect(html.match(/data-workspace-pane-role="work"/g)).toHaveLength(3);
    expect(html).toContain('class="popup-menu-anchor"><button class="button primary icon-only popup-menu-trigger"');
    expect(html).toContain('class="popup-menu action-list popup-menu-anchored" id="fixed_workspace_workspace-1_add_menu" role="menu" aria-label="Open Work view" popover="auto"');
    expect(html).toContain('class="action-item action-item__primary" type="submit" role="menuitem"');
  });

  test("server-renders the Workspace pane once at the shell seam", () => {
    const html = renderWorkspacePane({ projects: [{ id: "project-1", title: "Atelier", workspaces: [
      { id: "workspace-1", title: "Typed shell", active: true, attention: true, attentionAt: 123 },
      { id: "workspace-2", title: "Working", state: "deleting" },
    ] }], emptyProjects: [{ id: "project-2", title: "Empty" }], projectlessWorkspaces: [{ id: "workspace-3", title: "Scratch" }] }, '<button data-update-probe>Restart to update</button>');

    expect(html).toContain('class="fixed-shell-workspace-pane"');
    const workspaceHeader = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    expect(workspaceHeader).toContain('<strong><svg aria-hidden="true"');
    expect(workspaceHeader.indexOf("<svg")).toBeLessThan(workspaceHeader.indexOf("Atelier"));
    expect(workspaceHeader).toContain('href="/settings"');
    expect(workspaceHeader).toContain('aria-label="Settings"');
    expect(workspaceHeader).toContain('aria-label="Collapse Workspace pane"');
    expect(html).toContain('data-controller="modal-opener"');
    expect(html).toContain('data-action="click->workspace-navigation#selectWorkspace"');
    expect(html).toContain('href="/projects/project-1/launch-composer" data-turbo-frame="launch_composer" aria-label="New workspace: Atelier"');
    expect(html).toContain('href="/projects/project-1/editor" data-turbo-frame="project_editor_frame" data-controller="modal-opener"');
    const projectHeading = html.slice(html.indexOf('class="fixed-shell-project-heading-row action-item"'), html.indexOf('class="fixed-shell-project-workspaces'));
    expect(projectHeading).toContain('<svg class="disclosure-icon" aria-hidden="true"');
    expect(projectHeading.indexOf("<svg")).toBeLessThan(projectHeading.indexOf("Atelier"));
    expect(projectHeading.indexOf("Atelier")).toBeLessThan(projectHeading.indexOf("fixed-shell-project-settings"));
    expect(projectHeading.indexOf("fixed-shell-project-settings")).toBeLessThan(projectHeading.indexOf("fixed-shell-project-add"));
    expect(html).toContain('data-project-id="__projectless__"><svg');
    expect(html).toContain('<span class="action-item__label"><span class="action-item__label-text">Projectless</span></span>');
    expect(html).toContain('href="/launch-composer" data-turbo-frame="launch_composer" aria-label="New projectless workspace"');
    expect(html.indexOf('data-project-id="__projectless__"')).toBeLessThan(html.indexOf('data-project-id="__projects_drawer__"'));
    const drawerProjects = html.slice(html.indexOf('data-project-id="__projects_drawer__"'));
    expect(html).toContain('class="fixed-shell-project action-list fixed-shell-projects-drawer is-collapsed" data-project-id="__projects_drawer__"');
    expect(drawerProjects).toContain('aria-expanded="false"');
    expect(drawerProjects).toContain('<span class="action-item__label"><span class="action-item__label-text">Projects</span></span>');
    expect(drawerProjects).toContain('<a class="fixed-shell-project-add button secondary icon-only" href="/projects/new/editor"');
    expect(drawerProjects).toContain('<a class="fixed-shell-project-heading action-item__primary" href="/projects/project-2/launch-composer" data-turbo-frame="launch_composer" aria-label="New workspace: Empty"><span class="action-item__label"><span class="action-item__label-text">Empty</span></span></a>');
    expect(drawerProjects.match(/href="\/projects\/project-1\/launch-composer"/g)).toHaveLength(2);
    expect(drawerProjects.match(/href="\/projects\/project-2\/launch-composer"/g)).toHaveLength(2);
    expect(drawerProjects).not.toContain('data-workspace-entry-id="workspace-1"');
    expect(drawerProjects).not.toContain('data-project-id="__projectless__"');
    expect(drawerProjects).not.toContain('fixed-shell-project-settings" href="/projects/new/editor"');
    expect(html).not.toContain("<footer>");
    expect(html).not.toContain("New Project");
    expect(html).not.toContain("fixed-shell-workspace-color");
    expect(html).toContain('data-workspace-attention-at="123"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('class="status-spinner sm fixed-shell-workspace-busy action-item__status" aria-label="Workspace deleting"');
    expect(html).toContain('<section id="global_sidebar_contributions"><button data-update-probe>Restart to update</button></section>');
  });

  test("renders one Workspace status using lifecycle, busy activity, Attention, then outdated-image precedence", () => {
    const row = (status: { state?: "starting" | "deleting" | "requires_delete_confirmation" | "idle"; attention?: boolean; busyViewKeys?: readonly string[] }) => renderWorkspacePane({
      projects: [],
      projectlessWorkspaces: [{ id: "workspace", title: "Workspace", outdated: true, ...status }],
    });

    const starting = row({ state: "starting", attention: true, busyViewKeys: ["agent:one"] });
    const deleting = row({ state: "deleting", attention: true, busyViewKeys: ["agent:one"] });
    const busy = row({ state: "idle", attention: true, busyViewKeys: ["agent:one"] });
    const attention = row({ state: "requires_delete_confirmation", attention: true });
    expect(row({ state: "idle" })).toContain("fixed-shell-workspace-warning");
    expect(starting).toContain('aria-label="Workspace starting"');
    expect(starting).not.toContain('aria-label="Workspace busy"');
    expect(deleting).toContain('aria-label="Workspace deleting"');
    expect(deleting).not.toContain('aria-label="Workspace busy"');
    expect(busy).toContain('aria-label="Workspace busy"');
    expect(busy).not.toContain('aria-label="Attention"');
    expect(attention).toContain('aria-label="Attention"');
    expect(attention).not.toContain("fixed-shell-workspace-warning");
  });

  test("renders a parked disclosure only inside Projects that have parked Workspaces", () => {
    const html = renderWorkspacePane({
      projects: [
        {
          id: "mixed-project",
          title: "Mixed",
          workspaces: [{ id: "active", title: "Active workspace" }],
          parkedWorkspaces: [{ id: "parked-1", title: "First parked" }, { id: "parked-2", title: "Second parked" }],
        },
        { id: "active-only-project", title: "Active only", workspaces: [{ id: "active-2", title: "Another active workspace" }] },
      ],
      projectlessWorkspaces: [],
    });
    const mixedProject = html.slice(html.indexOf('data-project-id="mixed-project"'), html.indexOf('data-project-id="active-only-project"'));
    const activeOnlyProject = html.slice(html.indexOf('data-project-id="active-only-project"'), html.indexOf('data-project-id="__projectless__"'));

    expect(mixedProject).toContain("fixed-shell-parked is-collapsed");
    expect(mixedProject).toContain('aria-expanded="false"');
    expect(mixedProject).toContain("2 parked");
    expect(mixedProject).toContain("First parked");
    expect(mixedProject).toContain('action="/workspaces/parked-1/unpark"');
    expect(mixedProject).toContain('data-action="submit->workspace-navigation#unparkWorkspace"');
    expect(activeOnlyProject).not.toContain("fixed-shell-parked");
    expect(activeOnlyProject).not.toContain("parked");
  });

  test("keeps the Projectless launcher in Workspaces and marks the first Project target", () => {
    const html = renderWorkspacePane({ projects: [], projectlessWorkspaces: [] });
    const workspaceSection = html.slice(html.indexOf('class="fixed-shell-workspace-scroll"'), html.indexOf('class="fixed-shell-project action-list fixed-shell-projects-drawer'));
    const projectsSection = html.slice(html.indexOf('class="fixed-shell-project action-list fixed-shell-projects-drawer'));

    expect(workspaceSection).toContain('data-project-id="__projectless__"');
    expect(workspaceSection).toContain("Projectless");
    expect(workspaceSection).toContain('href="/launch-composer"');
    expect(projectsSection).not.toContain('data-project-id="__projectless__"');
    expect(projectsSection).toContain('class="fixed-shell-project-add button secondary icon-only is-onboarding-target" data-empty-workspace-onboarding-destination="first-project"');
    expect(projectsSection).toContain('class="fixed-shell-project action-list fixed-shell-projects-drawer is-collapsed"');
  });

  test("shows the workspace name and delete action in a single-conversation Agent header", () => {
    const html = renderWorkspacePresentation(fixture({
      agentConversations: [{ id: firstConversationId, title: "Agent", bodyUrl: agentBodyUrl(firstConversationId) }],
      commands: [
        { id: "agent.create", label: "New Agent", scope: "workspace", placement: "agent-action" },
        { id: "browser.create", label: "New Browser", scope: "workspace", placement: "work-launcher" },
      ],
    }));
    const header = html.slice(html.indexOf('<section class="fixed-shell-agent-pane"'), html.indexOf('<div class="fixed-shell-agent-bodies"'));

    expect(header).toContain("Typed shell");
    expect(header).not.toContain("Atelier");
    expect(header).toContain('class="fixed-shell-park-workspace"');
    expect(header).toContain('action="/workspaces/workspace-1/park"');
    expect(header).toContain('class="button secondary icon-only" type="submit" title="New Agent" aria-label="New Agent"');
    expect(header).toContain('class="button secondary icon-only" type="submit" title="Park workspace" aria-label="Park workspace"');
    expect(header.indexOf('class="fixed-shell-park-workspace"')).toBeLessThan(header.indexOf('class="fixed-shell-delete-workspace"'));
    expect(header).toContain('class="fixed-shell-delete-workspace"');
    expect(header).toContain('action="/workspaces/workspace-1/delete"');
    expect(header).toContain('class="button danger icon-only" type="button" title="Delete workspace" aria-label="Delete workspace"');
    expect(header).toContain('class="button danger destructive-confirmation__action" type="submit">Yes, delete</button>');
    expect(header).toContain('class="button secondary destructive-confirmation__cancel" type="button">Oops</button>');
    expect(header).toContain('class="button secondary icon-only" title="Show Work pane" aria-label="Show Work pane"');
    expect(html).toContain('class="button primary icon-only popup-menu-trigger" type="button" title="Open Work view" aria-label="Open Work view" aria-haspopup="menu"');
    expect(html).toContain('class="button secondary icon-only" title="Collapse Work pane" aria-label="Collapse Work pane"');
  });

  test("shows robot icons and fullscreen wiring on Agent tabs", () => {
    const multiple = renderWorkspacePresentation(fixture());
    const agentTabs = multiple.slice(multiple.indexOf('aria-label="Agent conversations"'), multiple.indexOf('</header>', multiple.indexOf('aria-label="Agent conversations"')));
    expect(agentTabs.match(/class="fixed-shell-agent-icon"/g)).toHaveLength(2);
    expect(agentTabs.match(/data-controller="atelier-fullscreen"/g)).toHaveLength(2);
    expect(agentTabs).toContain(`data-atelier-fullscreen-view-key-value="${firstConversationId}"`);
    expect(agentTabs).toContain('data-atelier-fullscreen-title-value="First"');
    expect(multiple).toContain(`data-atelier-fullscreen-view-key="${firstConversationId}"`);
    expect(agentTabs.indexOf('class="fixed-shell-agent-icon"')).toBeLessThan(agentTabs.indexOf('class="action-item__label-text">First'));

    const single = renderWorkspacePresentation(fixture({ agentConversations: [{ id: firstConversationId, title: "Agent", bodyUrl: agentBodyUrl(firstConversationId) }] }));
    const singleHeader = single.slice(single.indexOf('<section class="fixed-shell-agent-pane"'), single.indexOf('</header>', single.indexOf('<section class="fixed-shell-agent-pane"')));
    expect(singleHeader.match(/class="fixed-shell-agent-icon"/g)).toHaveLength(1);
    expect(singleHeader.indexOf('class="fixed-shell-agent-icon"')).toBeLessThan(singleHeader.indexOf("Typed shell"));
  });

  test("shows each Work view type icon before its tab title", () => {
    const base = fixture();
    const html = renderWorkspacePresentation(fixture({ workViews: [
      ...base.workViews,
      { key: "review:workspace", label: "Review", kind: "contextual", availability: { phase: "live" }, bodyHtml: "<p>Review</p>" },
    ] }));
    const selectors = html.slice(html.indexOf('aria-label="Work views"'), html.indexOf('</header>', html.indexOf('aria-label="Work views"')));

    for (const [type, label] of [["terminal", "Terminal"], ["files", "Files"], ["browser", "Preview"], ["review", "Review"]]) {
      const tab = selectors.slice(selectors.indexOf(`data-work-view-key="${type}:`));
      expect(tab).toContain(`class="fixed-shell-work-view-icon" data-icon="${type}"`);
      expect(tab.indexOf(`data-icon="${type}"`)).toBeLessThan(tab.indexOf(`class="action-item__label-text">${label}`));
    }
  });

  test("uses Action Items for closable Agent and Work tabs", () => {
    const close = { action: "/close", label: "view" };
    const html = renderWorkspacePresentation(fixture({
      agentConversations: [
        { id: firstConversationId, title: "First", bodyUrl: agentBodyUrl(firstConversationId), close },
        { id: secondConversationId, title: "Second", bodyUrl: agentBodyUrl(secondConversationId), close },
      ],
      workViews: [
        { key: "terminal:one", label: "Terminal", kind: "resource", availability: { phase: "live" }, bodyHtml: "<p>Terminal</p>", close },
      ],
    }));

    const desktop = html.slice(0, html.indexOf('aria-label="Current workspace destinations"'));
    expect(desktop.match(/fixed-shell-agent-conversation action-item/g)).toHaveLength(2);
    expect(desktop).toContain('class="fixed-shell-work-view-selector action-item"');
    expect(desktop.match(/class="action-item__actions action-item__actions--engaged"/g)).toHaveLength(3);
    expect(desktop.match(/class="fixed-shell-view-close button danger icon-only"/g)).toHaveLength(3);
    expect(desktop.match(/class="destructive-confirmation"/g)).toHaveLength(4);
    expect(desktop.match(/>Yes, close<\/button>/g)).toHaveLength(3);
    expect(desktop.match(/>Oops<\/button>/g)).toHaveLength(4);
    const mobileMore = html.slice(html.indexOf('role="menu" aria-label="More"'));
    expect(mobileMore).toContain('role="menuitem"');
    expect(mobileMore).toContain('Close current view');
  });

  test("renders expensive Work bodies as lazy hydration frames", () => {
    const html = renderWorkspacePresentation(fixture({ workViews: [{
      key: "review:workspace",
      label: "Review",
      kind: "contextual",

      availability: { phase: "live" },
      bodyUrl: "/workspaces/workspace-1/work-views/review%3Aworkspace/body",
    }] }));

    expect(html).toContain('src="/workspaces/workspace-1/work-views/review%3Aworkspace/body"');
    expect(html).toContain('loading="lazy" data-work-view-hydration');
    expect(html).toContain('class="work-view-hydration-loading" role="status" aria-label="Loading Review"');
    expect(html).not.toContain("Loading Review…");
    expect(html).not.toContain("review-body");
  });

  test("renders Agent summaries as stable lazy body slots keyed by conversation identity", () => {
    const html = renderWorkspacePresentation(fixture());

    expect(html).toContain(`id="${agentNavigationDomId("workspace-1")}"`);
    expect(html).toContain(`id="${agentActionsDomId("workspace-1")}"`);
    expect(html).toContain(`id="${agentBodiesDomId("workspace-1")}"`);
    expect(html).toContain(`id="${agentPaneSlotDomId("workspace-1", firstConversationId)}"`);
    expect(html).toContain(`id="${agentBodyFrameId("workspace-1", firstConversationId)}" src="${agentBodyUrl(firstConversationId)}" loading="lazy" data-agent-body-hydration`);
    expect(html).toContain(`id="${agentBodyFrameId("workspace-1", secondConversationId)}" src="${agentBodyUrl(secondConversationId)}" loading="lazy" data-agent-body-hydration`);
    expect(html).not.toContain("Transcript");
    expect(html).not.toContain("data-workspace-live-node");
    expect(html).not.toContain("data-workspace-live-slot");
  });

  test("renders availability independently from Attention and visibility", () => {
    const html = renderWorkspacePresentation(fixture());

    expect(html).toContain("fixed-shell-availability-reconnecting");
    expect(html).toContain("Reconnecting without replacing the listing.");
    expect(html).toContain("fixed-shell-availability-unavailable");
    expect(html).toContain("Preview exited.");
    expect(html).toContain("<button>Retry</button>");
    expect(html).toContain('aria-label="Attention"');
    expect(html).toContain('data-attention-sequence="7"');
  });

  test("renders every existing Work view for responsive mobile navigation with Browser and Review first", () => {
    const base = fixture();
    const html = renderWorkspacePresentation(fixture({ workViews: [
      ...base.workViews,
      { key: "review:workspace", label: "Review", kind: "contextual", availability: { phase: "live" }, bodyHtml: "<p>Review</p>" },
    ] }));

    expect(html).not.toContain('data-mobile-destination="workspace"');
    for (const destination of ["agents", "work:terminal:one", "work:browser:preview", "work:files:workspace", "work:review:workspace"]) {
      expect(html).toContain(`data-mobile-destination="${destination}"`);
    }
    expect(html.match(/data-mobile-destination="agents"/g)).toHaveLength(1);
    expect(html).not.toContain('data-mobile-destination="agent:');
    expect(html).toContain('role="menu" aria-label="More"');
    expect(html).toContain('role="menuitemradio" aria-checked="false" hidden data-more-work-key="files:workspace"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-label="Hidden Attention" data-mobile-overflow-attention hidden');
    const mobileDestinations = html.slice(html.indexOf('data-mobile-overflow-container'), html.indexOf('</div>', html.indexOf('data-mobile-overflow-container')));
    expect(mobileDestinations.indexOf('data-mobile-destination="work:browser:preview"')).toBeLessThan(mobileDestinations.indexOf('data-mobile-destination="work:review:workspace"'));
    expect(mobileDestinations.indexOf('data-mobile-destination="work:review:workspace"')).toBeLessThan(mobileDestinations.indexOf('data-mobile-destination="work:terminal:one"'));
    expect(mobileDestinations.indexOf('data-mobile-destination="work:terminal:one"')).toBeLessThan(mobileDestinations.indexOf('data-mobile-destination="work:files:workspace"'));
    expect(html).not.toContain("fixed-shell-more-scrim");
  });

  test("renders creation actions below the Work-view overflow candidates", () => {
    const html = renderWorkspacePresentation(fixture({
      workViews: fixture().workViews.filter((view) => view.key !== "files:workspace"),
      commands: [
        { id: "files.create", label: "New Files", scope: "workspace", placement: "work-launcher" },
        { id: "browser.create", label: "New Browser", scope: "workspace", placement: "work-launcher" },
      ],
    }));

    const more = html.slice(html.indexOf('class="fixed-shell-more-menu popup-menu action-list"'));
    expect(more).toContain('role="menu" aria-label="More"');
    expect(more).not.toContain("Open or create");
    expect(more.indexOf('data-more-work-key="terminal:one"')).toBeLessThan(more.indexOf('/commands/files.create'));
    expect(more).toContain('/commands/files.create');
    expect(more).toContain('class="action-item__label-text">New Files</span>');
    expect(more).toContain('/commands/browser.create');
    expect(more).toContain('class="action-item__label-text">New Browser</span>');
  });

  test("inserts one newly opened Work view without replacing the Workspace presentation", () => {
    const presentation = fixture();
    const html = openWorkViewTurboStream("workspace-1", presentation.workViews, "browser:preview");

    expect(html).not.toContain('action="replace-workspace-presentation"');
    expect(html).toContain('action="update" target="fixed_workspace_workspace-1_selectors"');
    expect(html).toContain('action="append" target="fixed_workspace_workspace-1_bodies"');
    expect(html).toContain('data-workspace-pane-id="browser:preview"');
    expect(html).not.toContain('data-probe="terminal"');
    expect(html).toContain('target="fixed_workspace_workspace-1_mobile_destinations"');
  });

  test("targets the deleted Workspace's resident presentation", () => {
    expect(removeWorkspaceResidentTurboStream("workspace-1")).toBe('<turbo-stream action="remove-workspace-resident" target="fixed_workspace_workspace-1"></turbo-stream>');
  });

  test("Agent add and close streams target only navigation, actions, and identified pane slots", () => {
    const added = agentTabsTurboStream(fixture(), { addedConversationId: secondConversationId, selectConversationId: secondConversationId });

    expect(added).toContain(`action="update" target="${agentNavigationDomId("workspace-1")}"`);
    expect(added).toContain(`action="update" target="${agentActionsDomId("workspace-1")}"`);
    expect(added).toContain(`action="append" target="${agentBodiesDomId("workspace-1")}"`);
    expect(added).toContain(`id="${agentPaneSlotDomId("workspace-1", secondConversationId)}"`);
    expect(added).toContain('action="select-agent"');
    expect(added).toContain(`data-conversation-id="${secondConversationId}"`);
    expect(added).toContain('action="invalidate-workspace-preparation"');
    expect(added).not.toContain('action="replace" target="fixed_workspace_workspace-1"');
    expect(added).not.toContain("replace-workspace-presentation");

    const closed = agentTabsTurboStream(fixture({ agentConversations: [fixture().agentConversations[1]!] }), {
      removedConversationId: firstConversationId,
      successorConversationId: secondConversationId,
    });
    expect(closed).toContain(`action="update" target="${agentNavigationDomId("workspace-1")}"`);
    expect(closed).not.toContain(`id="${agentTabDomId("workspace-1", firstConversationId)}"`);
    expect(closed).toContain(`action="remove" target="${agentPaneSlotDomId("workspace-1", firstConversationId)}"`);
    expect(closed).toContain('action="select-agent-successor"');
    expect(closed).toContain(`data-closed-conversation-id="${firstConversationId}"`);
    expect(closed).toContain(`data-successor-conversation-id="${secondConversationId}"`);
    expect(closed).not.toContain(`src="${agentBodyUrl(secondConversationId)}"`);
  });

  test("Work reorder, attention, availability, and close streams preserve existing bodies", () => {
    const reordered = [...fixture().workViews].reverse();
    const updated = workViewsTurboStream("workspace-1", reordered, { selectKey: "files:workspace", intendSelection: true });

    expect(updated).toContain('action="update" target="fixed_workspace_workspace-1_selectors"');
    expect(updated.indexOf(`id="${workViewSelectorDomId("workspace-1", "browser:preview")}"`)).toBeLessThan(updated.indexOf(`id="${workViewSelectorDomId("workspace-1", "terminal:one")}"`));
    expect(updated).toContain(`action="update" target="${workViewAvailabilityDomId("workspace-1", "files:workspace")}"`);
    expect(updated).toContain(`action="update" target="${workViewActionsDomId("workspace-1", "files:workspace")}"`);
    expect(updated).toContain('action="intend-work-view"');
    expect(updated).toContain('data-work-view-key="files:workspace"');
    expect(updated).not.toContain('action="replace" target="fixed_workspace_workspace-1"');
    expect(updated).not.toContain('data-probe="terminal"');

    const remaining = fixture().workViews.filter((view) => view.key !== "files:workspace");
    const closed = workViewsTurboStream("workspace-1", remaining, { removedKey: "files:workspace", successorKey: "terminal:one" });
    expect(closed).toContain(`action="remove" target="${workViewPaneDomId("workspace-1", "files:workspace")}"`);
    expect(closed).toContain('action="select-work-view-successor"');
    expect(closed).toContain('data-successor-work-view-key="terminal:one"');
    expect(closed).not.toContain(`action="replace" target="${workViewPaneDomId("workspace-1", "terminal:one")}"`);
  });

  test("authoritative body endpoints return only their stable Turbo Frame contracts", () => {
    expect(renderAgentBodyFrame("workspace-1", firstConversationId, "<article>Agent body</article>")).toBe(
      `<turbo-frame id="${agentBodyFrameId("workspace-1", firstConversationId)}"><article>Agent body</article></turbo-frame>`,
    );
    expect(renderWorkViewBodyFrame("workspace-1", "terminal:one", "<article>Terminal body</article>")).toBe(
      `<turbo-frame id="${workViewBodyFrameId("workspace-1", "terminal:one")}"><article>Terminal body</article></turbo-frame>`,
    );
  });

  test("requires the Workspace invariant of at least one Agent conversation", () => {
    expect(() => renderWorkspacePresentation(fixture({ agentConversations: [] }))).toThrow("requires an Agent conversation");
  });
});
