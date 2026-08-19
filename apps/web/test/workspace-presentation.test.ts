import { describe, expect, test } from "bun:test";
import { renderWorkspacePane, renderWorkspacePresentation, workspacePresentationTurboStream, type WorkspacePresentation } from "../src/server/workspace-presentation.ts";

function fixture(overrides: Partial<WorkspacePresentation> = {}): WorkspacePresentation {
  return {
    workspace: { id: "workspace-1", title: "Typed shell" },
    agentConversations: [
      { id: "agent-a", title: "First", bodyHtml: '<textarea data-probe="agent-a">draft</textarea>' },
      { id: "agent-b", title: "Second", bodyHtml: '<div data-probe="agent-b">Transcript</div>' },
    ],
    workViews: [
      { key: "terminal:one", label: "Terminal", kind: "resource", mobileDestination: "direct", attention: false, availability: { phase: "live" }, bodyHtml: '<div data-probe="terminal">Terminal</div>' },
      { key: "files:workspace", label: "Files", kind: "contextual", mobileDestination: "more", attention: true, availability: { phase: "reconnecting", detail: "Reconnecting without replacing the listing." }, bodyHtml: '<div data-probe="files">Listing</div>' },
      { key: "browser:preview", label: "Preview", kind: "resource", mobileDestination: "direct", attention: false, availability: { phase: "unavailable", detail: "Preview exited.", recoveryHtml: "<button>Retry</button>" }, bodyHtml: "<iframe></iframe>" },
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
    ] }] });

    expect(html).toContain('class="fixed-shell-workspace-pane"');
    expect(html).toContain('data-controller="modal-opener"');
    expect(html).toContain('data-action="click->workspace-navigation#selectWorkspace"');
    expect(html).toContain('class="fixed-shell-workspace-row active"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('class="status-spinner sm fixed-shell-workspace-busy" aria-label="Workspace busy"');
  });

  test("shows only the workspace name in a single-conversation Agent header", () => {
    const html = renderWorkspacePresentation(fixture({
      agentConversations: [{ id: "agent-a", title: "Agent", bodyHtml: "<p>Agent</p>" }],
    }));
    const header = html.slice(html.indexOf('<section class="fixed-shell-agent-pane"'), html.indexOf('<div class="fixed-shell-agent-bodies"'));

    expect(header).toContain("Typed shell");
    expect(header).not.toContain("Atelier");
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
