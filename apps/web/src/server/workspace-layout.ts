// In-memory, non-persistent tab/group layout state per workspace.
// Rebuilt lazily from module tab contributions; intentionally does not survive restarts.

export interface WorkspaceGroupState {
  id: string;
  tabs: string[];
  activeTab?: string;
  size: number;
}

export interface WorkspaceLayoutState {
  groups: WorkspaceGroupState[];
  closedTabs?: string[];
}

export interface MoveTabRequest {
  tab: string;
  toGroup?: string;
  toIndex?: number;
  newGroup?: boolean;
}

export interface WorkspaceLayoutStore {
  /** Reconcile the stored layout with the tab keys that currently exist. */
  normalize(workspaceId: string, tabKeys: string[]): WorkspaceLayoutState;
  splitGroup(workspaceId: string, tabKeys: string[], groupId: string): void;
  removeEmptyGroup(workspaceId: string, tabKeys: string[], groupId: string): void;
  closeGroup(workspaceId: string, tabKeys: string[], groupId: string): void;
  moveTab(workspaceId: string, tabKeys: string[], request: MoveTabRequest): void;
  closeTab(workspaceId: string, tabKeys: string[], tab: string): void;
  resize(workspaceId: string, tabKeys: string[], sizes: number[]): void;
  setActiveTab(workspaceId: string, groupId: string, tab: string): void;
  /** Place a newly available tab into a group and activate it. */
  placeNewTab(workspaceId: string, tabKeys: string[], groupId: string, tabKey: string): void;
  /** Ensure a tab is visible and active in a group that contains no agent tabs. */
  ensureTabInAgentFreeGroup(workspaceId: string, tabKeys: string[], tabKey: string): { groupId: string; moved: boolean; createdGroup: boolean } | undefined;
  delete(workspaceId: string): void;
}

function normalizeGroupSizes(layout: WorkspaceLayoutState): void {
  const total = layout.groups.reduce((sum, group) => sum + (Number.isFinite(group.size) && group.size > 0 ? group.size : 1), 0) || 1;
  for (const group of layout.groups) group.size = (Number.isFinite(group.size) && group.size > 0 ? group.size : 1) / total;
}

export function createWorkspaceLayoutStore(): WorkspaceLayoutStore {
  const layouts = new Map<string, WorkspaceLayoutState>();

  function normalize(workspaceId: string, tabKeys: string[]): WorkspaceLayoutState {
    let layout = layouts.get(workspaceId);
    if (!layout || layout.groups.length === 0) {
      layout = { groups: [{ id: crypto.randomUUID(), tabs: [...tabKeys], activeTab: tabKeys[0], size: 1 }], closedTabs: [] };
      layouts.set(workspaceId, layout);
      return layout;
    }
    layout.closedTabs = (layout.closedTabs ?? []).filter((key) => tabKeys.includes(key));
    const closedSet = new Set(layout.closedTabs);
    const visibleTabKeys = tabKeys.filter((key) => !closedSet.has(key));
    const keySet = new Set(visibleTabKeys);
    const assigned = new Set(layout.groups.flatMap((group) => group.tabs));
    const missing = visibleTabKeys.filter((key) => !assigned.has(key));
    layout.groups[0]?.tabs.push(...missing);
    for (const group of layout.groups) {
      group.tabs = group.tabs.filter((key) => keySet.has(key));
      if (!group.activeTab || !group.tabs.includes(group.activeTab)) group.activeTab = group.tabs[0];
    }
    normalizeGroupSizes(layout);
    return layout;
  }

  return {
    normalize,

    splitGroup(workspaceId, tabKeys, groupId) {
      const layout = normalize(workspaceId, tabKeys);
      const index = layout.groups.findIndex((group) => group.id === groupId);
      const insertAt = index >= 0 ? index + 1 : layout.groups.length;
      layout.groups.splice(insertAt, 0, { id: crypto.randomUUID(), tabs: [], size: 1 });
      normalizeGroupSizes(layout);
    },

    removeEmptyGroup(workspaceId, tabKeys, groupId) {
      const layout = normalize(workspaceId, tabKeys);
      const index = layout.groups.findIndex((group) => group.id === groupId);
      if (index >= 0 && layout.groups.length > 1 && layout.groups[index]?.tabs.length === 0) layout.groups.splice(index, 1);
      normalizeGroupSizes(layout);
    },

    closeGroup(workspaceId, tabKeys, groupId) {
      const layout = normalize(workspaceId, tabKeys);
      const index = layout.groups.findIndex((group) => group.id === groupId);
      if (index > 0 && layout.groups.length > 1) {
        const [closed] = layout.groups.splice(index, 1);
        const left = layout.groups[index - 1];
        if (closed && left) {
          left.tabs.push(...closed.tabs.filter((tab) => !left.tabs.includes(tab)));
          left.activeTab = closed.activeTab ?? left.activeTab;
        }
      }
      normalizeGroupSizes(layout);
    },

    moveTab(workspaceId, tabKeys, request) {
      const layout = normalize(workspaceId, tabKeys);
      const { tab } = request;
      const source = layout.groups.find((group) => group.tabs.includes(tab));
      let target = layout.groups.find((group) => group.id === request.toGroup);
      if (tab && request.newGroup === true && source) {
        target = { id: crypto.randomUUID(), tabs: [], size: 1 };
        layout.groups.push(target);
      }
      if (!tab || !target) return;
      const wasActive = source?.activeTab === tab;
      if (source) {
        const oldIndex = source.tabs.indexOf(tab);
        source.tabs = source.tabs.filter((key) => key !== tab);
        if (wasActive) source.activeTab = source.tabs[Math.max(0, oldIndex - 1)] ?? source.tabs[0];
      }
      const toIndex = typeof request.toIndex === "number" && Number.isFinite(request.toIndex)
        ? Math.max(0, Math.min(request.toIndex, target.tabs.length))
        : target.tabs.length;
      target.tabs.splice(toIndex, 0, tab);
      target.activeTab = tab;
      if (source && source !== target && source.tabs.length === 0 && layout.groups.length > 1) {
        const sourceIndex = layout.groups.indexOf(source);
        if (sourceIndex >= 0) layout.groups.splice(sourceIndex, 1);
      }
      normalizeGroupSizes(layout);
    },

    closeTab(workspaceId, tabKeys, tab) {
      if (!tabKeys.includes(tab)) return;
      const layout = normalize(workspaceId, tabKeys);
      const closedTabs = new Set(layout.closedTabs ?? []);
      closedTabs.add(tab);
      layout.closedTabs = [...closedTabs];
      for (const group of layout.groups) {
        const oldIndex = group.tabs.indexOf(tab);
        if (oldIndex < 0) continue;
        group.tabs = group.tabs.filter((key) => key !== tab);
        if (group.activeTab === tab) group.activeTab = group.tabs[Math.max(0, oldIndex - 1)] ?? group.tabs[0];
      }
      normalizeGroupSizes(layout);
    },

    resize(workspaceId, tabKeys, sizes) {
      const layout = normalize(workspaceId, tabKeys);
      if (sizes.length === layout.groups.length) layout.groups.forEach((group, index) => { group.size = sizes[index] ?? 1; });
      normalizeGroupSizes(layout);
    },

    setActiveTab(workspaceId, groupId, tab) {
      const group = layouts.get(workspaceId)?.groups.find((candidate) => candidate.id === groupId);
      if (group?.tabs.includes(tab)) group.activeTab = tab;
    },

    placeNewTab(workspaceId, tabKeys, groupId, tabKey) {
      const layout = normalize(workspaceId, tabKeys);
      const group = layout.groups.find((candidate) => candidate.id === groupId) ?? layout.groups[0];
      if (!group) return;
      if (!group.tabs.includes(tabKey)) {
        layout.closedTabs = (layout.closedTabs ?? []).filter((tab) => tab !== tabKey);
        for (const candidate of layout.groups) candidate.tabs = candidate.tabs.filter((tab) => tab !== tabKey);
        group.tabs.push(tabKey);
      }
      group.activeTab = tabKey;
    },

    ensureTabInAgentFreeGroup(workspaceId, tabKeys, tabKey) {
      if (!tabKeys.includes(tabKey)) return undefined;
      const layout = normalize(workspaceId, tabKeys);
      layout.closedTabs = (layout.closedTabs ?? []).filter((tab) => tab !== tabKey);
      const hasAgent = (group: WorkspaceGroupState) => group.tabs.some((tab) => tab.startsWith("agent:"));
      const source = layout.groups.find((group) => group.tabs.includes(tabKey));
      if (source && !hasAgent(source)) {
        source.activeTab = tabKey;
        return { groupId: source.id, moved: false, createdGroup: false };
      }

      let target = layout.groups.find((group) => !hasAgent(group) && group !== source);
      let createdGroup = false;
      if (!target) {
        target = { id: crypto.randomUUID(), tabs: [], size: 1 };
        layout.groups.push(target);
        createdGroup = true;
      }

      for (const group of layout.groups) group.tabs = group.tabs.filter((tab) => tab !== tabKey);
      target.tabs.push(tabKey);
      target.activeTab = tabKey;
      if (source && source !== target && source.tabs.length === 0 && layout.groups.length > 1) {
        const sourceIndex = layout.groups.indexOf(source);
        if (sourceIndex >= 0) layout.groups.splice(sourceIndex, 1);
      }
      normalizeGroupSizes(layout);
      return { groupId: target.id, moved: source !== target, createdGroup };
    },

    delete(workspaceId) {
      layouts.delete(workspaceId);
    },
  };
}
