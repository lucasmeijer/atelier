import { describe, expect, test } from "bun:test";
import { openWorkViewTurboStream, removeWorkspaceResidentTurboStream, renderWorkspacePane, renderWorkspacePresentation, workspacePresentationTurboStream, type WorkspacePresentation } from "../src/server/workspace-presentation.ts";

function fixture(overrides: Partial<WorkspacePresentation> = {}): WorkspacePresentation {
  return {
    workspace: { id: "workspace-1", title: "Typed shell" },
    agentConversations: [
      { id: "agent-a", title: "First", bodyHtml: '<textarea data-probe="agent-a">draft</textarea>' },
      { id: "agent-b", title: "Second", bodyHtml: '<div data-probe="agent-b">Transcript</div>' },
    ],
    workViews: [
      { key: "terminal:one", label: "Terminal", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: '<div data-probe="terminal">Terminal</div>' },
      { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attentionSequence: 7, availability: { phase: "reconnecting", detail: "Reconnecting without replacing the listing." }, bodyHtml: '<div data-probe="files">Listing</div>' },
      { key: "browser:preview", label: "Preview", kind: "resource", mobileDestination: "direct", availability: { phase: "unavailable", detail: "Preview exited.", recoveryHtml: "<button>Retry</button>" }, bodyHtml: "<iframe></iframe>" },
    ],
    ...overrides,
  };
}

describe("role-fixed Workspace presentation", () => {
  test("server-renders fixed roles without selecting personal navigation", () => {
    const html = renderWorkspacePresentation(fixture());

    expect(html).toContain('data-controller="workspace-presentation"');
    expect(html).not.toContain('class="fixed-shell-workspace-pane"');
    expect(html).toContain('class="fixed-shell-agent-pane"');
    expect(html).toContain('class="fixed-shell-work-pane"');
    expect(html).not.toContain("workspace-group");
    expect(html).not.toContain("visibleTab");
    expect(html).not.toContain('aria-selected="true"');
    expect(html.match(/data-workspace-pane-role="agent"/g)).toHaveLength(2);
    expect(html.match(/data-workspace-pane-role="work"/g)).toHaveLength(3);
  });

  test("server-renders the Workspace pane once at the shell seam", () => {
    const html = renderWorkspacePane({ projects: [{ id: "project-1", title: "Atelier", workspaces: [
      { id: "workspace-1", title: "Typed shell", active: true, unreadAt: 123 },
      { id: "workspace-2", title: "Working", busy: true },
    ] }], emptyProjects: [{ id: "project-2", title: "Empty" }], projectlessWorkspaces: [{ id: "workspace-3", title: "Scratch" }] }, '<button data-update-probe>Restart to update</button>');

    expect(html).toContain('class="fixed-shell-workspace-pane"');
    expect(html).not.toContain("Close Workspace pane");
    expect(html).not.toContain("Open Workspace pane");
    expect(html).not.toContain("<strong>Atelier</strong>");
    expect(html).toContain('data-controller="modal-opener"');
    expect(html).toContain('data-action="click->workspace-navigation#selectWorkspace"');
    expect(html).toContain('href="/projects/project-1/agent-launch" data-turbo-frame="agent_launch_modal" aria-label="New workspace: Atelier"');
    expect(html).toContain('href="/projects/project-1/editor" data-turbo-frame="project_editor_frame" data-controller="modal-opener"');
    const projectHeading = html.slice(html.indexOf('class="fixed-shell-project-heading-row fixed-shell-navigation-action action-item"'), html.indexOf('class="fixed-shell-project-workspaces"'));
    expect(projectHeading).toContain('<svg class="disclosure-icon" aria-hidden="true"');
    expect(projectHeading.indexOf("<svg")).toBeLessThan(projectHeading.indexOf("Atelier"));
    expect(projectHeading.indexOf("Atelier")).toBeLessThan(projectHeading.indexOf("fixed-shell-project-settings"));
    expect(projectHeading.indexOf("fixed-shell-project-settings")).toBeLessThan(projectHeading.indexOf("fixed-shell-project-add"));
    expect(html).toContain('data-project-id="__projectless__"><svg');
    expect(html).toContain('<span class="action-item__label"><span class="action-item__label-text">Projectless</span></span></button><a class="fixed-shell-project-action fixed-shell-project-add action-item__action button secondary icon-only" href="/agent-launch" data-turbo-frame="agent_launch_modal" aria-label="New projectless workspace"');
    expect(html.indexOf('data-project-id="__projectless__"')).toBeLessThan(html.indexOf('data-project-id="__projects_drawer__"'));
    const drawerProjects = html.slice(html.indexOf('data-project-id="__projects_drawer__"'));
    expect(html).toContain('class="fixed-shell-project fixed-shell-projects-drawer is-collapsed" data-project-id="__projects_drawer__"');
    expect(drawerProjects).toContain('aria-expanded="false"');
    expect(drawerProjects).toContain('<span class="action-item__label"><span class="action-item__label-text">Projects</span></span>');
    expect(drawerProjects).toContain('<a class="fixed-shell-project-action fixed-shell-project-add action-item__action button secondary icon-only" href="/projects/new/editor"');
    expect(drawerProjects).toContain('<a class="fixed-shell-project-heading fixed-shell-project-launch action-item__primary" href="/projects/project-2/agent-launch" data-turbo-frame="agent_launch_modal" aria-label="New workspace: Empty"><span class="action-item__label"><span class="action-item__label-text">Empty</span></span></a>');
    expect(drawerProjects.match(/href="\/projects\/project-1\/agent-launch"/g)).toHaveLength(2);
    expect(drawerProjects.match(/href="\/projects\/project-2\/agent-launch"/g)).toHaveLength(2);
    expect(drawerProjects).not.toContain('data-workspace-entry-id="workspace-1"');
    expect(drawerProjects).not.toContain('data-project-id="__projectless__"');
    expect(drawerProjects).not.toContain('fixed-shell-project-settings" href="/projects/new/editor"');
    expect(html.indexOf('class="fixed-shell-projects-drawer')).toBeLessThan(html.indexOf("<footer>"));
    expect(html).toContain('<a class="fixed-shell-navigation-action action-item action-item__primary" href="/settings" data-turbo-frame="_top" data-turbo-stream="true"><span class="action-item__label"><span class="action-item__label-text">Settings</span></span></a>');
    expect(html).not.toContain("fixed-shell-settings");
    expect(html).not.toContain("New Project");
    expect(html).toContain('class="fixed-shell-workspace-row action-item action-item__primary active"');
    expect(html).not.toContain("fixed-shell-workspace-color");
    expect(html).toContain('data-workspace-unread-at="123"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('class="status-spinner sm fixed-shell-workspace-busy action-item__status" aria-label="Workspace busy"');
    expect(html).toContain('<section id="global_sidebar_contributions"><button data-update-probe>Restart to update</button></section>');
  });

  test("shows the outdated-image warning only when no higher-priority status is present", () => {
    const row = (status: { busy?: boolean; unreadAt?: number }) => renderWorkspacePane({
      projects: [],
      projectlessWorkspaces: [{ id: "workspace", title: "Workspace", outdated: true, ...status }],
    });

    const busy = row({ busy: true });
    const unread = row({ unreadAt: 123 });
    expect(row({})).toContain("fixed-shell-workspace-warning");
    expect(busy).toContain("fixed-shell-workspace-busy");
    expect(busy).not.toContain("fixed-shell-workspace-warning");
    expect(unread).toContain("fixed-shell-attention-dot");
    expect(unread).not.toContain("fixed-shell-workspace-warning");
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
    const workspaceSection = html.slice(html.indexOf('class="fixed-shell-workspace-scroll"'), html.indexOf('class="fixed-shell-project fixed-shell-projects-drawer'));
    const projectsSection = html.slice(html.indexOf('class="fixed-shell-project fixed-shell-projects-drawer'));

    expect(workspaceSection).toContain('data-project-id="__projectless__"');
    expect(workspaceSection).toContain("Projectless");
    expect(workspaceSection).toContain('href="/agent-launch"');
    expect(projectsSection).not.toContain('data-project-id="__projectless__"');
    expect(projectsSection).toContain('class="fixed-shell-project-action fixed-shell-project-add action-item__action button secondary icon-only is-onboarding-target" data-empty-workspace-onboarding-destination="first-project"');
    expect(projectsSection).toContain('class="fixed-shell-project fixed-shell-projects-drawer is-collapsed"');
  });

  test("expands Projects and marks the first Workspace target when no Workspace exists", () => {
    const html = renderWorkspacePane({
      projects: [],
      emptyProjects: [{ id: "project-z", title: "Zulu" }, { id: "project-a", title: "Alpha" }],
      projectlessWorkspaces: [],
    });
    const projectsSection = html.slice(html.indexOf('class="fixed-shell-project fixed-shell-projects-drawer'));

    expect(projectsSection).toContain('class="fixed-shell-project fixed-shell-projects-drawer" data-project-id="__projects_drawer__"');
    expect(projectsSection).toContain('aria-expanded="true"');
    expect(projectsSection.match(/is-onboarding-target/g)).toHaveLength(1);
    expect(projectsSection.indexOf("Alpha")).toBeLessThan(projectsSection.indexOf('data-empty-workspace-onboarding-destination="first-workspace"'));
    expect(projectsSection.indexOf("Alpha")).toBeLessThan(projectsSection.indexOf("Zulu"));
  });

  test("shows the workspace name and delete action in a single-conversation Agent header", () => {
    const html = renderWorkspacePresentation(fixture({
      agentConversations: [{ id: "agent-a", title: "Agent", bodyHtml: "<p>Agent</p>" }],
    }));
    const header = html.slice(html.indexOf('<section class="fixed-shell-agent-pane"'), html.indexOf('<div class="fixed-shell-agent-bodies"'));

    expect(header).toContain("Typed shell");
    expect(header).not.toContain("Atelier");
    expect(header).toContain('class="fixed-shell-park-workspace"');
    expect(header).toContain('action="/workspaces/workspace-1/park"');
    expect(header).toContain('title="Park workspace" aria-label="Park workspace"');
    expect(header.indexOf('class="fixed-shell-park-workspace"')).toBeLessThan(header.indexOf('class="fixed-shell-delete-workspace"'));
    expect(header).toContain('class="fixed-shell-delete-workspace"');
    expect(header).toContain('action="/workspaces/workspace-1/delete"');
    expect(header).toContain('title="Delete workspace" aria-label="Delete workspace"');
    expect(header).toContain('aria-label="Show Work pane"');
    expect(html).toContain('aria-label="Collapse Work pane"');
  });

  test("uses Action Items for closable Agent and Work tabs", () => {
    const close = { action: "/close", label: "view" };
    const html = renderWorkspacePresentation(fixture({
      agentConversations: [
        { id: "agent-a", title: "First", bodyHtml: "<p>First</p>", close },
        { id: "agent-b", title: "Second", bodyHtml: "<p>Second</p>", close },
      ],
      workViews: [
        { key: "terminal:one", label: "Terminal", kind: "resource", mobileDestination: "direct", availability: { phase: "live" }, bodyHtml: "<p>Terminal</p>", close },
      ],
    }));

    expect(html.match(/fixed-shell-agent-conversation action-item/g)).toHaveLength(2);
    expect(html).toContain('class="fixed-shell-work-view-selector action-item"');
    expect(html.match(/class="action-item__label"><span class="action-item__label-text"/g)).toHaveLength(3);
    expect(html.match(/class="fixed-shell-view-close action-item__action button danger icon-only"/g)).toHaveLength(3);
    expect(html.match(/M6 6l12 12M18 6L6 18/g)).toHaveLength(3);
  });

  test("keeps adapter HTML inside stable type-native live nodes", () => {
    const html = renderWorkspacePresentation(fixture());

    expect(html).toContain('data-workspace-live-node="agent:agent-a"');
    expect(html).toContain('data-workspace-live-node="work:terminal:one"');
    expect(html).toContain('data-work-view-key="terminal:one"');
    expect(html).toContain('data-probe="agent-a"');
    expect(html).toContain('data-probe="terminal"');
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

  test("renders phone Resource destinations and discovers Contextual views through More", () => {
    const html = renderWorkspacePresentation(fixture());

    expect(html).toContain('data-mobile-destination="work:terminal:one"');
    expect(html).toContain('data-mobile-destination="work:browser:preview"');
    expect(html).not.toContain('data-mobile-destination="work:files:workspace"');
    expect(html).toContain('aria-label="Terminal" title="Terminal" data-mobile-destination="work:terminal:one"');
    expect(html).toContain('aria-label="Preview" title="Preview" data-mobile-destination="work:browser:preview"');
    expect(html).toContain('aria-label="First" title="First" data-mobile-destination="agent:agent-a"');
    expect(html).toContain('data-more-work-key="files:workspace"');
    expect(html).toContain('aria-label="Hidden Attention"');
    expect(html).not.toContain("fixed-shell-more-scrim");
  });

  test("keeps the closed Files singleton discoverable with secondary Work views", () => {
    const html = renderWorkspacePresentation(fixture({
      workViews: fixture().workViews.filter((view) => view.key !== "files:workspace"),
      commands: [
        { id: "files.open", label: "Files", scope: "workspace", placement: "work-launcher" },
        { id: "browser.create", label: "New Browser", scope: "workspace", placement: "work-launcher" },
      ],
    }));

    const more = html.slice(html.indexOf('class="fixed-shell-more-menu"'));
    expect(more).not.toContain("Secondary Work views");
    expect(more).toContain('aria-label="Close More"');
    expect(more).toContain('/commands/files.open');
    expect(more.indexOf('/commands/files.open')).toBeLessThan(more.indexOf("Open or create"));
    expect(more.indexOf('/commands/browser.create')).toBeGreaterThan(more.indexOf("Open or create"));
  });

  test("inserts one newly opened Work view without replacing the Workspace presentation", () => {
    const presentation = fixture();
    const html = openWorkViewTurboStream("workspace-1", presentation.workViews, "browser:preview");

    expect(html).not.toContain('action="replace-workspace-presentation"');
    expect(html).toContain('action="update" target="fixed_workspace_workspace-1_selectors"');
    expect(html).toContain('action="append" target="fixed_workspace_workspace-1_bodies"');
    expect(html).toContain('data-workspace-pane-id="browser:preview"');
    expect(html).not.toContain('data-probe="terminal"');
    expect(html).toContain('target="fixed_workspace_workspace-1_mobile_direct"');
  });

  test("targets the deleted Workspace's resident presentation", () => {
    expect(removeWorkspaceResidentTurboStream("workspace-1")).toBe('<turbo-stream action="remove-workspace-resident" target="fixed_workspace_workspace-1"></turbo-stream>');
  });

  test("renders transplant slots only for explicitly preserved live nodes", () => {
    const presentation = fixture({ preserveLiveKeys: new Set(["agent:agent-a", "work:terminal:one"]) });
    const html = workspacePresentationTurboStream("workspace-1", presentation);

    expect(html).toContain('action="replace-workspace-presentation"');
    expect(html).toContain('data-workspace-live-slot="agent:agent-a"');
    expect(html).toContain('data-workspace-live-slot="work:terminal:one"');
    expect(html).not.toContain('data-probe="agent-a"');
    expect(html).toContain('data-probe="agent-b"');
  });

  test("requires the Workspace invariant of at least one Agent conversation", () => {
    expect(() => renderWorkspacePresentation(fixture({ agentConversations: [] }))).toThrow("requires an Agent conversation");
  });
});
