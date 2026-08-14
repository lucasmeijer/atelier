import { describe, expect, test } from "bun:test";
import { renderWorkspacePresentation, workspacePresentationTurboStream, type WorkspacePresentation } from "../src/server/workspace-presentation.ts";

function fixture(overrides: Partial<WorkspacePresentation> = {}): WorkspacePresentation {
  return {
    workspace: { id: "workspace-1", title: "Typed shell", projectTitle: "Atelier" },
    projects: [{ id: "project-1", title: "Atelier", workspaces: [{ id: "workspace-1", title: "Typed shell", ready: true }] }],
    agentConversations: [
      { id: "agent-a", title: "First", bodyHtml: '<textarea data-probe="agent-a">draft</textarea>' },
      { id: "agent-b", title: "Second", bodyHtml: '<div data-probe="agent-b">Transcript</div>' },
    ],
    workViews: [
      { key: "terminal:one", label: "Terminal", kind: "resource", attention: false, availability: { phase: "live" }, bodyHtml: '<div data-probe="terminal">Terminal</div>' },
      { key: "changes", label: "Changes", kind: "contextual", attention: true, availability: { phase: "reconnecting", detail: "Reconnecting without replacing the diff." }, bodyHtml: '<div data-probe="changes">Diff</div>' },
      { key: "browser:preview", label: "Preview", kind: "resource", attention: false, availability: { phase: "unavailable", detail: "Preview exited.", recoveryHtml: "<button>Retry</button>" }, bodyHtml: "<iframe></iframe>" },
    ],
    ...overrides,
  };
}

describe("role-fixed Workspace presentation", () => {
  test("server-renders fixed roles without selecting personal navigation", () => {
    const html = renderWorkspacePresentation(fixture());

    expect(html).toContain('data-controller="workspace-presentation"');
    expect(html).toContain('class="fixed-shell-workspace-pane"');
    expect(html).toContain('class="fixed-shell-agent-pane"');
    expect(html).toContain('class="fixed-shell-work-pane"');
    expect(html).not.toContain("workspace-group");
    expect(html).not.toContain("visibleTab");
    expect(html).not.toContain('aria-selected="true"');
    expect(html.match(/data-workspace-pane-role="agent"/g)).toHaveLength(2);
    expect(html.match(/data-workspace-pane-role="work"/g)).toHaveLength(3);
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
    expect(html).toContain("Reconnecting without replacing the diff.");
    expect(html).toContain("fixed-shell-availability-unavailable");
    expect(html).toContain("Preview exited.");
    expect(html).toContain("<button>Retry</button>");
    expect(html).toContain('aria-label="Attention"');
  });

  test("renders phone Resource destinations and discovers Contextual views through More", () => {
    const html = renderWorkspacePresentation(fixture());

    expect(html).toContain('data-mobile-destination="work:terminal:one"');
    expect(html).toContain('data-mobile-destination="work:browser:preview"');
    expect(html).toContain('data-mobile-destination="work:changes" data-mobile-contextual-key="changes"');
    expect(html).toContain('data-more-work-key="changes"');
    expect(html).toContain('aria-label="Hidden Attention"');
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
