import { describe, expect, test } from "bun:test";
import { removeWorkspaceResidentTurboStream, renderWorkspacePane, renderWorkspacePresentation, workspacePresentationTurboStream, type WorkspacePresentation } from "../src/server/workspace-presentation.ts";

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
      { id: "workspace-1", title: "Typed shell", color: "#3b82f6", active: true, ready: true },
      { id: "workspace-2", title: "Working", color: "#3b82f6", busy: true },
    ] }], emptyProjects: [{ id: "project-2", title: "Empty" }], projectlessWorkspaces: [{ id: "workspace-3", title: "Scratch" }] }, '<button data-update-probe>Restart to update</button>');

    expect(html).toContain('class="fixed-shell-workspace-pane"');
    expect(html).toContain('data-controller="modal-opener"');
    expect(html).toContain('data-action="click->workspace-navigation#selectWorkspace"');
    expect(html).toContain('href="/projects/project-1/agent-launch" data-turbo-frame="agent_launch_modal" aria-label="New workspace: Atelier"');
    expect(html).toContain('href="/projects/project-1/editor" data-turbo-frame="project_editor_frame" data-controller="modal-opener"');
    const projectHeading = html.slice(html.indexOf('class="fixed-shell-project-heading-row"'), html.indexOf('class="fixed-shell-project-workspaces"'));
    expect(projectHeading.indexOf("<svg")).toBeLessThan(projectHeading.indexOf("Atelier"));
    expect(projectHeading.indexOf("Atelier")).toBeLessThan(projectHeading.indexOf("fixed-shell-project-settings"));
    expect(projectHeading.indexOf("fixed-shell-project-settings")).toBeLessThan(projectHeading.indexOf("fixed-shell-project-add"));
    expect(html).toContain('data-project-id="__projectless__"><svg');
    expect(html).toContain('<span>Projectless</span></button><a class="fixed-shell-project-action fixed-shell-project-add" href="/agent-launch" data-turbo-frame="agent_launch_modal" aria-label="New projectless workspace"');
    expect(html.indexOf('data-project-id="__projectless__"')).toBeLessThan(html.indexOf('data-project-id="__projects_drawer__"'));
    const drawerProjects = html.slice(html.indexOf('data-project-id="__projects_drawer__"'));
    expect(html).toContain('class="fixed-shell-project fixed-shell-projects-drawer is-collapsed" data-project-id="__projects_drawer__"');
    expect(drawerProjects).toContain('aria-expanded="false"');
    expect(drawerProjects).toContain('<span>Projects</span>');
    expect(drawerProjects).toContain('<a class="fixed-shell-project-action fixed-shell-project-add" href="/projects/new/editor"');
    expect(drawerProjects).toContain('<a class="fixed-shell-project-heading fixed-shell-project-launch" href="/projects/project-2/agent-launch" data-turbo-frame="agent_launch_modal" aria-label="New workspace: Empty"><span>Empty</span></a>');
    expect(drawerProjects.match(/href="\/projects\/project-1\/agent-launch"/g)).toHaveLength(2);
    expect(drawerProjects.match(/href="\/projects\/project-2\/agent-launch"/g)).toHaveLength(2);
    expect(drawerProjects).not.toContain('data-workspace-entry-id="workspace-1"');
    expect(drawerProjects).not.toContain('data-project-id="__projectless__"');
    expect(drawerProjects).not.toContain('fixed-shell-project-settings" href="/projects/new/editor"');
    expect(html.indexOf('class="fixed-shell-projects-drawer')).toBeLessThan(html.indexOf("<footer>"));
    expect(html).not.toContain("New Project");
    expect(html).toContain('class="fixed-shell-workspace-row active"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('class="status-spinner sm fixed-shell-workspace-busy" aria-label="Workspace busy"');
    expect(html).toContain('<section id="global_sidebar_contributions"><button data-update-probe>Restart to update</button></section>');
  });

  test("keeps the Projectless launcher in Workspaces when it has no Workspaces", () => {
    const html = renderWorkspacePane({ projects: [], projectlessWorkspaces: [] });
    const workspaceSection = html.slice(html.indexOf('class="fixed-shell-workspace-scroll"'), html.indexOf('class="fixed-shell-project fixed-shell-projects-drawer'));
    const projectsSection = html.slice(html.indexOf('class="fixed-shell-project fixed-shell-projects-drawer'));

    expect(workspaceSection).toContain('data-project-id="__projectless__"');
    expect(workspaceSection).toContain("Projectless");
    expect(workspaceSection).toContain('href="/agent-launch"');
    expect(projectsSection).not.toContain('data-project-id="__projectless__"');
  });

  test("shows the workspace name and delete action in a single-conversation Agent header", () => {
    const html = renderWorkspacePresentation(fixture({
      agentConversations: [{ id: "agent-a", title: "Agent", bodyHtml: "<p>Agent</p>" }],
    }));
    const header = html.slice(html.indexOf('<section class="fixed-shell-agent-pane"'), html.indexOf('<div class="fixed-shell-agent-bodies"'));

    expect(header).toContain("Typed shell");
    expect(header).not.toContain("Atelier");
    expect(header).toContain('class="fixed-shell-delete-workspace"');
    expect(header).toContain('action="/workspaces/workspace-1/delete"');
    expect(header).toContain('title="Delete workspace" aria-label="Delete workspace"');
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
