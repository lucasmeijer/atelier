import { describe, expect, test } from "bun:test";
import { oldestReadyFirst, retainedWorkspaceIds } from "../src/client/workspace-residency-policy.ts";

describe("Workspace residency policy", () => {
  test("retains the visible Workspace, then oldest unread, then most recently used inactive residents", () => {
    const retained = retainedWorkspaceIds([
      { workspaceId: "visible", visible: true, prepared: true, lastActivatedAt: 1 },
      { workspaceId: "old-ready", visible: false, prepared: true, unreadAt: 10, lastActivatedAt: 1 },
      { workspaceId: "new-ready", visible: false, prepared: true, unreadAt: 20, lastActivatedAt: 9 },
      { workspaceId: "recent", visible: false, prepared: true, lastActivatedAt: 50 },
      { workspaceId: "stale", visible: false, prepared: true, lastActivatedAt: 2 },
      { workspaceId: "oldest", visible: false, prepared: true, lastActivatedAt: 1 },
    ], 5);

    expect([...retained]).toEqual(["visible", "old-ready", "new-ready", "recent", "stale"]);
  });

  test("protects a foreground destination while capacity is made available", () => {
    const retained = retainedWorkspaceIds([
      { workspaceId: "old-ready", visible: false, prepared: true, unreadAt: 1, lastActivatedAt: 0 },
      { workspaceId: "new-foreground", visible: false, prepared: false, lastActivatedAt: 0, protected: true },
    ], 1);

    expect([...retained]).toEqual(["new-foreground"]);
  });

  test("never evicts the visible Workspace even for a protected destination", () => {
    const retained = retainedWorkspaceIds([
      { workspaceId: "visible", visible: true, prepared: true, lastActivatedAt: 1 },
      { workspaceId: "new-foreground", visible: false, prepared: false, lastActivatedAt: 0, protected: true },
    ], 1);

    expect([...retained]).toEqual(["visible"]);
  });

  test("does not give an invalidated unread resident prepared-ready retention priority", () => {
    const retained = retainedWorkspaceIds([
      { workspaceId: "invalidated-old-ready", visible: false, prepared: false, unreadAt: 1, lastActivatedAt: 100 },
      { workspaceId: "prepared-new-ready", visible: false, prepared: true, unreadAt: 2, lastActivatedAt: 1 },
    ], 1);

    expect([...retained]).toEqual(["prepared-new-ready"]);
  });

  test("admits the active oldest-ready preparation candidate ahead of read inactive residents", () => {
    const retained = retainedWorkspaceIds([
      { workspaceId: "read", visible: false, prepared: true, lastActivatedAt: 100 },
      { workspaceId: "incoming-ready", visible: false, prepared: false, preparing: true, unreadAt: 2, lastActivatedAt: 0 },
    ], 1);

    expect([...retained]).toEqual(["incoming-ready"]);
  });

  test("orders ready Workspaces by their first unread time with a stable tie break", () => {
    expect(oldestReadyFirst([
      { workspaceId: "later", unreadAt: 20 },
      { workspaceId: "beta", unreadAt: 10 },
      { workspaceId: "alpha", unreadAt: 10 },
    ])).toEqual([
      { workspaceId: "alpha", unreadAt: 10 },
      { workspaceId: "beta", unreadAt: 10 },
      { workspaceId: "later", unreadAt: 20 },
    ]);
  });
});
