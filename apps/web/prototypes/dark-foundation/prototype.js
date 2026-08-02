// Settled prototype: Open views is the sole mobile navigation model.
const prototypeStateKey = "atelier-dark-foundation-desktop-v3";
history.scrollRestoration = "manual";
window.scrollTo(0, 0);
const prototypeUrl = new URL(location.href);
prototypeUrl.searchParams.delete("mobile-nav");
prototypeUrl.searchParams.delete("agent-tabs");
history.replaceState(null, "", prototypeUrl);
const defaultViewOrder = ["file", "browser", "changes", "terminal"];
const defaultExpandedProjects = {
  atelier: true,
  fastpaperwork: false,
  wayfinder: true,
  sandbox: true,
  none: true,
};
const main = document.querySelector(".main");
const workPane = document.querySelector(".work");
const workTabs = document.querySelector(".work-tabs");
const divider = document.querySelector(".divider");
const workspaceTrigger = document.querySelector(".sidebar-trigger");
const workspaceScroll = document.querySelector("[data-workspace-scroll]");
const workspaceTree = document.querySelector("[data-workspace-tree]");
const workTrigger = document.querySelector(".work-trigger");
const documentViewIds = ["file", "browser", "terminal"];
const mobileViewDetails = {
  file: { label: "work-view.ts", icon: "file" },
  browser: { label: "Preview", icon: "browser" },
  changes: { label: "Changes", icon: "git" },
  terminal: { label: "Terminal", icon: "terminal" },
};
const mobileIndicators = new Set(["browser", "changes"]);
let pendingMobileCloseView = null;
let conversationState = {
  multiple: false,
  active: "primary",
  secondaryTitle: "Untitled",
};

function loadInteractionState() {
  const saved = JSON.parse(localStorage.getItem(prototypeStateKey) || "null");
  return {
    workspaceOpen: saved?.workspaceOpen ?? true,
    workOpen: saved?.workOpen ?? true,
    activeView: saved?.activeView ?? "file",
    workSize: saved?.workSize ?? null,
    order: Array.isArray(saved?.order) ? saved.order : [...defaultViewOrder],
    openViews: Array.isArray(saved?.openViews)
      ? saved.openViews
      : [...defaultViewOrder],
    drawers: saved?.drawers ?? { file: false, changes: false },
    expandedProjects: {
      ...defaultExpandedProjects,
      ...(saved?.expandedProjects ?? {}),
    },
    activeWorkspace: saved?.activeWorkspace ?? "redesign-tabs",
    sidebarScroll: saved?.sidebarScroll ?? 0,
    readyWorkspaces: Array.isArray(saved?.readyWorkspaces)
      ? saved.readyWorkspaces
      : ["persisted-work-views", "extract-invoices"],
  };
}

let interaction = loadInteractionState();
let resizingWork = false;
let draggedView = null;

function saveInteractionState() {
  localStorage.setItem(prototypeStateKey, JSON.stringify(interaction));
}

function isMobile() {
  return matchMedia("(max-width: 760px)").matches;
}

function workspaceOverlays() {
  return matchMedia("(max-width: 1160px)").matches;
}

function projectGroup(project) {
  return document.querySelector(`[data-project-group="${project}"]`);
}

function setProjectExpanded(project, expanded, { persist = true } = {}) {
  const group = projectGroup(project);
  if (!group) return;
  const toggle = group.querySelector('[data-action="toggle-project"]');
  group.dataset.expanded = String(expanded);
  toggle.setAttribute("aria-expanded", String(expanded));
  interaction.expandedProjects[project] = expanded;
  if (persist) saveInteractionState();
}

function syncProjectState() {
  document.querySelectorAll("[data-project-group]").forEach((group) => {
    setProjectExpanded(
      group.dataset.projectGroup,
      interaction.expandedProjects[group.dataset.projectGroup] ?? true,
      { persist: false },
    );
  });
}

function syncWorkspaceReadyState() {
  document.querySelectorAll(".task[data-workspace]").forEach((row) => {
    const marker = row.querySelector(".workspace-status");
    const shouldBeReady = interaction.readyWorkspaces.includes(
      row.dataset.workspace,
    );
    const existingDot = marker.querySelector(".ready-dot");
    if (shouldBeReady && !existingDot) {
      const dot = document.createElement("i");
      dot.className = "ready-dot";
      dot.title = "Agent ready";
      marker.append(dot);
    } else if (!shouldBeReady) {
      existingDot?.remove();
    }
  });
}

function setWorkspaceReady(workspace, ready) {
  interaction.readyWorkspaces = interaction.readyWorkspaces.filter(
    (candidate) => candidate !== workspace,
  );
  if (ready) interaction.readyWorkspaces.push(workspace);
  syncWorkspaceReadyState();
  saveInteractionState();
}

function keepWorkspaceItemVisible(item) {
  const containerRect = workspaceScroll.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  if (itemRect.top < containerRect.top) {
    workspaceScroll.scrollTop -= containerRect.top - itemRect.top;
  } else if (itemRect.bottom > containerRect.bottom) {
    workspaceScroll.scrollTop += itemRect.bottom - containerRect.bottom;
  }
}

function scrollAgentToNewest({ focusComposer = true } = {}) {
  const panel = document.querySelector(
    `[data-conversation-panel="${conversationState.active}"]`,
  );
  const transcript = panel?.querySelector(".transcript");
  const newest = transcript?.querySelector(".message:last-child");
  if (transcript && newest) {
    transcript.style.scrollBehavior = "auto";
    transcript.scrollTop +=
      newest.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
    requestAnimationFrame(() => {
      transcript.style.removeProperty("scroll-behavior");
    });
  }
  if (focusComposer) activeComposer()?.focus({ preventScroll: true });
}

function activateWorkspace(
  workspace,
  { focusComposer = true, handoff = true } = {},
) {
  const row = document.querySelector(`.task[data-workspace="${workspace}"]`);
  if (!row) return;
  const changed = interaction.activeWorkspace !== workspace;
  const project = row.dataset.project;
  setProjectExpanded(project, true);
  document.querySelectorAll(".task.current").forEach((task) => {
    task.classList.toggle("current", task === row);
  });
  interaction.activeWorkspace = workspace;
  if (handoff) keepWorkspaceItemVisible(row);

  const title = row.querySelector(".task-label").textContent.trim();
  const projectLabel =
    project === "none"
      ? "No project"
      : projectGroup(project).querySelector(".project-name").textContent.trim();
  document.querySelector("[data-workspace-title]").textContent = title;
  document.querySelector("[data-workspace-project]").textContent = projectLabel;
  document.querySelector("[data-delete-workspace-name]").textContent = title;
  setWorkspaceReady(workspace, false);
  saveInteractionState();

  if (!handoff) return;
  if (workspaceOverlays()) setWorkspaceOpen(false);
  if (isMobile()) showMobilePane("agent");

  const panel = document.querySelector(
    `[data-conversation-panel="${conversationState.active}"]`,
  );
  const composer = activeComposer();
  if (changed) {
    panel?.classList.add("workspace-switching");
    if (composer) composer.disabled = true;
    window.setTimeout(() => {
      panel?.classList.remove("workspace-switching");
      if (composer) composer.disabled = false;
      scrollAgentToNewest({ focusComposer });
    }, 320);
  } else {
    scrollAgentToNewest({ focusComposer });
  }
  updateStateNote(`${title} · newest message · composer focused`);
}

function openViewIds() {
  return [...document.querySelectorAll("[data-view-shell]")].map(
    (shell) => shell.dataset.viewShell,
  );
}

function viewTab(view) {
  return document.querySelector(`[data-view="${view}"]`);
}

function activeComposer() {
  return document.querySelector(
    `[data-conversation-panel="${conversationState.active}"] .composer textarea`,
  );
}

function conversationTabLabel(conversation) {
  return conversation === "primary"
    ? "Redesign tabs and Work views"
    : conversationState.secondaryTitle;
}

function conversationTabMarkup(conversation) {
  const active = conversationState.active === conversation;
  const close =
    conversation === "secondary"
      ? `<button class="conversation-tab-close" data-action="close-conversation" aria-label="Close ${conversationState.secondaryTitle}"><svg><use href="#x" /></svg></button>`
      : "";
  return `<span class="conversation-tab-shell">
    <button class="conversation-tab${active ? " active" : ""}" data-conversation="${conversation}" role="tab" aria-selected="${active}" tabindex="${active ? "0" : "-1"}">
      <span>${conversationTabLabel(conversation)}</span>
    </button>${close}
  </span>`;
}

function renderConversationState({ focusTab = false } = {}) {
  document.body.classList.toggle(
    "multiple-conversations",
    conversationState.multiple,
  );
  const tabs = conversationState.multiple
    ? `${conversationTabMarkup("primary")}${conversationTabMarkup("secondary")}`
    : "";
  document.querySelector("[data-conversation-tabs]").innerHTML = tabs;
  document.querySelectorAll("[data-conversation-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.conversationPanel !== conversationState.active;
  });
  const generatedHeading = document.querySelector(
    '[data-conversation-panel="secondary"] .conversation-empty h2',
  );
  generatedHeading.textContent =
    conversationState.secondaryTitle === "Untitled"
      ? "Start another conversation"
      : conversationState.secondaryTitle;
  document
    .querySelectorAll('[data-action="generate-conversation-title"] span')
    .forEach((label) => {
      label.textContent =
        conversationState.secondaryTitle === "Untitled"
          ? "Generate a title"
          : "Regenerate title";
    });
  if (focusTab) {
    document
      .querySelector(
        `[data-conversation-tabs] [data-conversation="${conversationState.active}"]`,
      )
      ?.focus();
  }
  updateStateNote();
}

function activateConversation(conversation, { focusTab = false } = {}) {
  conversationState.active = conversation;
  renderConversationState({ focusTab });
}

function addConversation() {
  if (!conversationState.multiple) {
    conversationState.multiple = true;
    conversationState.active = "secondary";
  }
  renderConversationState({ focusTab: true });
}

function closeSecondaryConversation() {
  conversationState = {
    multiple: false,
    active: "primary",
    secondaryTitle: "Untitled",
  };
  renderConversationState();
  document.querySelector('[data-action="add-conversation"]')?.focus();
}

function mobileDestinationMarkup(
  id,
  label,
  icon,
  { active = false, indicator = false } = {},
) {
  const destination = `<button class="mobile-view-destination${active ? " active" : ""}" data-mobile-destination="${id}" aria-label="${label}"${active ? ' aria-current="page"' : ""}>
    <span class="mobile-view-icon"><svg><use href="#${icon}" /></svg>${indicator ? '<i class="mobile-destination-dot"></i>' : ""}</span><span class="mobile-view-label">${label}</span>
  </button>`;
  return `<span class="mobile-view-destination-shell">${destination}</span>`;
}

function renderMobileViewBar() {
  const bar = document.querySelector("[data-mobile-view-switcher]");
  if (!bar) return;
  const workspaceActive = document.body.classList.contains("sidebar-open");
  const viewActive = document.body.classList.contains("mobile-work");
  const activeView = interaction.activeView;
  const documents = documentViewIds.filter((view) => viewTab(view));
  const contextual =
    viewActive && activeView && !documents.includes(activeView)
      ? [activeView]
      : [];
  bar.innerHTML = [
    mobileDestinationMarkup("workspace", "Workspace", "sidebar", {
      active: workspaceActive,
    }),
    mobileDestinationMarkup(
      "agent",
      "Agent",
      "sparkles",
      { active: !workspaceActive && !viewActive },
    ),
    ...documents.map((view) =>
      mobileDestinationMarkup(
        view,
        mobileViewDetails[view].label,
        mobileViewDetails[view].icon,
        {
          active: viewActive && activeView === view,
          indicator: mobileIndicators.has(view),
        },
      ),
    ),
    ...contextual.map((view) =>
      mobileDestinationMarkup(
        view,
        mobileViewDetails[view].label,
        mobileViewDetails[view].icon,
        {
          active: true,
          indicator: mobileIndicators.has(view),
        },
      ),
    ),
    mobileDestinationMarkup(
      "more",
      "More",
      "more",
      {
        active: document.body.classList.contains("mobile-more-open"),
        indicator: [...mobileIndicators].some(
          (view) => !documents.includes(view) && viewTab(view),
        ),
      },
    ),
  ].join("");
  document.querySelector("[data-mobile-more-row='changes']").hidden =
    !viewTab("changes");
  document.querySelector("[data-mobile-more-dot='changes']").hidden =
    !mobileIndicators.has("changes");
}

function requestMobileClose(view) {
  pendingMobileCloseView = view;
  const label = mobileViewDetails[view].label;
  document.querySelector("[data-mobile-close-name]").textContent = label;
  document.querySelector("#mobile-close-title").textContent = `Close ${label}?`;
  document.querySelector("#mobile-close-dialog").showModal();
}

function cancelMobileClose() {
  pendingMobileCloseView = null;
  document.querySelector("#mobile-close-dialog").close();
}

function confirmMobileClose() {
  const view = pendingMobileCloseView;
  pendingMobileCloseView = null;
  document.querySelector("#mobile-close-dialog").close();
  mobileIndicators.delete(view);
  closeView(view);
}

function updateStateNote(message) {
  const state = document.querySelector("[data-interaction-state]");
  if (!state) return;
  const width = Math.round(
    interaction.workSize || workPane.getBoundingClientRect().width,
  );
  const workspaceMode = workspaceOverlays()
    ? "Workspace overlay"
    : "Workspace docked";
  state.textContent =
    message ||
    `${isMobile() ? "Open views" : workspaceMode} · Work ${interaction.workOpen ? `${width}px` : "hidden"} · ${conversationState.multiple ? `2 conversations · ${conversationState.active}` : "1 conversation"}`;
}

function syncSidebar() {
  main.style.setProperty(
    "--workspace-offset",
    interaction.workspaceOpen && !workspaceOverlays() ? "275px" : "0px",
  );
  if (workspaceOverlays()) {
    document.body.classList.remove("sidebar-hidden");
    document.body.classList.toggle("sidebar-open", interaction.workspaceOpen);
  } else {
    document.body.classList.remove("sidebar-open");
    document.body.classList.toggle(
      "sidebar-hidden",
      !interaction.workspaceOpen,
    );
  }
  workspaceTrigger.setAttribute(
    "aria-label",
    interaction.workspaceOpen ? "Hide Workspace pane" : "Show Workspace pane",
  );
  workspaceTrigger.title = `${workspaceTrigger.getAttribute("aria-label")} (⌘\\)`;
  updateStateNote();
}

function setWorkspaceOpen(open, { focusPane = false } = {}) {
  const focusWasInside = document
    .querySelector(".sidebar")
    .contains(document.activeElement);
  interaction.workspaceOpen = open;
  syncSidebar();
  renderMobileViewBar();
  saveInteractionState();
  if (open && focusPane) {
    const activeWorkspace = document.querySelector(".task.current");
    activeWorkspace?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      workspaceScroll.scrollTop = interaction.sidebarScroll;
      if (activeWorkspace) keepWorkspaceItemVisible(activeWorkspace);
    });
  } else if (!open && focusWasInside) {
    workspaceTrigger.focus();
  }
}

function syncWorkVisibility() {
  document.body.classList.toggle("work-hidden", !interaction.workOpen);
  workTrigger.setAttribute(
    "aria-label",
    isMobile()
      ? "Show More"
      : interaction.workOpen
        ? "Hide Work pane"
        : "Show Work pane",
  );
  workTrigger.title = `${workTrigger.getAttribute("aria-label")} (⌘⇧\\)`;
  divider.setAttribute("aria-hidden", String(!interaction.workOpen));
  updateStateNote();
}

function setWorkOpen(open, { focusPane = false } = {}) {
  if (open && openViewIds().length === 0) return;
  const focusWasInside = workPane.contains(document.activeElement);
  interaction.workOpen = open;
  syncWorkVisibility();
  saveInteractionState();
  if (open && focusPane) {
    viewTab(interaction.activeView)?.focus();
  } else if (!open && focusWasInside) {
    workTrigger.focus();
  }
}

function syncDrawer() {
  const supportsDrawer = ["file", "changes"].includes(interaction.activeView);
  document.body.classList.toggle(
    "tree-open",
    supportsDrawer && interaction.drawers[interaction.activeView],
  );
  document.querySelector("[data-nav-title]").textContent =
    interaction.activeView === "changes" ? "Changed files" : "Files";
}

function activateView(view, { focusTab = false, revealWork = true } = {}) {
  if (!viewTab(view)) return;
  interaction.activeView = view;
  document.querySelectorAll("[data-view]").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) tab.querySelector(".attention-dot")?.remove();
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view;
  });
  syncDrawer();
  const activeLabel = viewTab(view)?.querySelector("span")?.textContent || view;
  document.querySelector("[data-mobile-work-title]").textContent =
    activeLabel;
  const mobileClose = document.querySelector("[data-mobile-close-active]");
  mobileClose.dataset.mobileCloseView = view;
  mobileClose.setAttribute("aria-label", `Close ${activeLabel}`);
  if (revealWork) setWorkOpen(true);
  if (focusTab) viewTab(view)?.focus();
  saveInteractionState();
  updateStateNote();
}

function closeView(view) {
  const ids = openViewIds();
  const closingIndex = ids.indexOf(view);
  if (closingIndex < 0) return;
  const closingActive = interaction.activeView === view;
  document.querySelector(`[data-view-shell="${view}"]`)?.remove();
  document.querySelector(`[data-view-panel="${view}"]`)?.remove();
  interaction.openViews = openViewIds();
  interaction.order = [...interaction.openViews];
  if (closingActive) {
    const replacement =
      interaction.openViews[closingIndex] ||
      interaction.openViews[closingIndex - 1] ||
      null;
    interaction.activeView = replacement;
    if (replacement) activateView(replacement, { focusTab: true });
    else {
      setWorkOpen(false);
      activeComposer().focus();
    }
  }
  saveInteractionState();
  renderMobileViewBar();
  updateStateNote(`${view} closed · explicit close unmounted it`);
}

function reorderView(view, beforeView) {
  const moving = document.querySelector(`[data-view-shell="${view}"]`);
  const before = beforeView
    ? document.querySelector(`[data-view-shell="${beforeView}"]`)
    : document.querySelector(".close-work");
  if (!moving || !before || moving === before) return;
  workTabs.insertBefore(moving, before);
  interaction.order = openViewIds();
  interaction.openViews = [...interaction.order];
  saveInteractionState();
  updateStateNote(`${view} reordered · order persists with the workspace`);
}

function requestAttention(view) {
  const tab = viewTab(view);
  if (!tab) return;
  if (!tab.querySelector(".attention-dot")) {
    const dot = document.createElement("i");
    dot.className = "attention-dot";
    tab.append(dot);
  }
  updateStateNote(`${view} requested attention`);
  requestAnimationFrame(() => {
    activateView(view, { focusTab: false, revealWork: true });
    if (isMobile()) showMobilePane("work");
    updateStateNote(`${view} visible · attention acknowledged`);
  });
}

function workWidthLimits() {
  const styles = getComputedStyle(main);
  const agentMin = Number.parseFloat(styles.getPropertyValue("--agent-min"));
  const workspaceOffset = Number.parseFloat(
    styles.getPropertyValue("--workspace-offset"),
  );
  return {
    min: 360,
    max: Math.min(760, main.clientWidth - agentMin - workspaceOffset),
  };
}

function setWorkWidth(width, { persist = true } = {}) {
  const limits = workWidthLimits();
  const clamped = Math.round(Math.min(limits.max, Math.max(limits.min, width)));
  interaction.workSize = clamped;
  main.style.setProperty("--work-size", `${clamped}px`);
  divider.setAttribute("aria-valuemin", String(limits.min));
  divider.setAttribute("aria-valuemax", String(Math.round(limits.max)));
  divider.setAttribute("aria-valuenow", String(clamped));
  if (persist) saveInteractionState();
  updateStateNote();
}

function resizeWork(clientX) {
  const bounds = main.getBoundingClientRect();
  setWorkWidth(bounds.right - clientX, { persist: false });
}

divider.addEventListener("pointerdown", (event) => {
  if (isMobile() || !interaction.workOpen) return;
  resizingWork = true;
  document.body.classList.add("resizing-work");
  resizeWork(event.clientX);
});

addEventListener("pointermove", (event) => {
  if (resizingWork) resizeWork(event.clientX);
});

function finishWorkResize() {
  if (!resizingWork) return;
  resizingWork = false;
  document.body.classList.remove("resizing-work");
  saveInteractionState();
  updateStateNote("Work width saved for this browser");
}

addEventListener("pointerup", finishWorkResize);
addEventListener("pointercancel", finishWorkResize);

divider.addEventListener("dblclick", () =>
  setWorkWidth(main.clientWidth * 0.44),
);
divider.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const limits = workWidthLimits();
  const width = workPane.getBoundingClientRect().width;
  const step = event.shiftKey ? 80 : 24;
  if (event.key === "Home") setWorkWidth(limits.min);
  else if (event.key === "End") setWorkWidth(limits.max);
  else setWorkWidth(width + (event.key === "ArrowLeft" ? step : -step));
});

workTabs.addEventListener("keydown", (event) => {
  const tab = event.target.closest("[data-view]");
  if (!tab) return;
  const tabs = [...document.querySelectorAll("[data-view]")];
  const current = tabs.indexOf(tab);
  let next = null;
  if (!event.altKey && event.key === "ArrowLeft") {
    next = tabs[(current - 1 + tabs.length) % tabs.length];
  }
  if (!event.altKey && event.key === "ArrowRight") {
    next = tabs[(current + 1) % tabs.length];
  }
  if (!event.altKey && event.key === "Home") next = tabs[0];
  if (!event.altKey && event.key === "End") next = tabs[tabs.length - 1];
  if (next) {
    event.preventDefault();
    activateView(next.dataset.view, { focusTab: true });
  }
  if (
    event.key === "Delete" ||
    (event.metaKey && event.key.toLowerCase() === "w")
  ) {
    event.preventDefault();
    closeView(tab.dataset.view);
  }
  if (
    event.altKey &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    event.preventDefault();
    const beforeIndex = event.key === "ArrowLeft" ? current - 1 : current + 2;
    const beforeView = tabs[beforeIndex]?.dataset.view;
    reorderView(tab.dataset.view, beforeView);
    tab.focus();
  }
});

workTabs.addEventListener("dragstart", (event) => {
  const shell = event.target.closest("[data-view-shell]");
  if (!shell) return;
  draggedView = shell.dataset.viewShell;
  shell.classList.add("dragging");
});

workTabs.addEventListener("dragover", (event) => {
  const shell = event.target.closest("[data-view-shell]");
  if (!draggedView || !shell || shell.dataset.viewShell === draggedView) return;
  event.preventDefault();
  const bounds = shell.getBoundingClientRect();
  const beforeView =
    event.clientX < bounds.left + bounds.width / 2
      ? shell.dataset.viewShell
      : shell.nextElementSibling?.dataset.viewShell;
  reorderView(draggedView, beforeView);
});

workTabs.addEventListener("dragend", () => {
  document
    .querySelector(".work-tab-shell.dragging")
    ?.classList.remove("dragging");
  draggedView = null;
});

workTabs.addEventListener("auxclick", (event) => {
  if (event.button === 1)
    closeView(event.target.closest("[data-view]")?.dataset.view);
});

const newWorkspaceDialog = document.querySelector("#new-workspace-dialog");
const searchDialog = document.querySelector("#search-dialog");
const settingsDialog = document.querySelector("#settings-dialog");
const editProjectDialog = document.querySelector("#edit-project-dialog");
const workspaceDeleteDialog = document.querySelector(
  "#workspace-delete-dialog",
);
const projectMenu = document.querySelector("[data-project-menu]");
const workspaceActions = document.querySelector("[data-workspace-actions]");

function selectProject(project) {
  const option = document.querySelector(
    `[data-action="choose-project"][data-project="${project}"]`,
  );
  document.querySelector("[data-selected-project]").textContent =
    project === "none" ? "No project" : project;
  document.querySelector("[data-project-origin]").textContent =
    option.dataset.origin;
  document
    .querySelector("[data-selected-project-swatch]")
    .style.setProperty("--project-color", option.dataset.color);
  document
    .querySelectorAll('[data-action="choose-project"]')
    .forEach((row) => row.classList.toggle("active", row === option));
  projectMenu.hidden = true;
}

function openNewWorkspace(project = "atelier") {
  selectProject(project);
  newWorkspaceDialog.showModal();
  document.querySelector("[data-workspace-prompt]").focus();
}

function openSearch() {
  searchDialog.showModal();
  document.querySelector("[data-search-input]").focus();
}

function showSettingsPage(page) {
  document.querySelectorAll("[data-settings-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsPage === page);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== page;
  });
}

function visibleSearchResults() {
  return [...document.querySelectorAll("[data-search-result]")].filter(
    (result) => !result.hidden,
  );
}

function selectSearchResult(index) {
  const results = visibleSearchResults();
  if (results.length === 0) return;
  const selected = results[(index + results.length) % results.length];
  results.forEach((result) =>
    result.classList.toggle("active", result === selected),
  );
  selected.scrollIntoView({ block: "nearest" });
}

document
  .querySelector("[data-search-input]")
  .addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll("[data-search-result]").forEach((result) => {
      result.hidden = !result.dataset.searchText.includes(query);
    });
    const results = visibleSearchResults();
    document.querySelector("[data-search-empty]").hidden = results.length > 0;
    if (results.length > 0) selectSearchResult(0);
  });

workspaceScroll.addEventListener("scroll", () => {
  if (document.body.classList.contains("workspace-list-loading")) return;
  interaction.sidebarScroll = workspaceScroll.scrollTop;
  saveInteractionState();
});

document.querySelectorAll(".prototype-dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

document.addEventListener("click", (event) => {
  const control = event.target.closest("button, [data-action]");
  if (!control) return;
  if (!control.closest(".workspace-title-actions")) {
    workspaceActions.hidden = true;
    document
      .querySelector('[data-action="toggle-workspace-actions"]')
      .setAttribute("aria-expanded", "false");
  }
  if (control.dataset.action === "toggle-project") {
    setProjectExpanded(
      control.dataset.project,
      control.getAttribute("aria-expanded") !== "true",
    );
  }
  if (control.dataset.action === "activate-workspace") {
    activateWorkspace(control.dataset.workspace);
  }
  if (control.dataset.conversation) {
    activateConversation(control.dataset.conversation);
  }
  if (control.dataset.action === "add-conversation") addConversation();
  if (control.dataset.action === "close-conversation") {
    closeSecondaryConversation();
  }
  if (control.dataset.action === "generate-conversation-title") {
    conversationState.secondaryTitle = "Explore agent conversation tabs";
    renderConversationState();
  }
  if (control.dataset.mobileCloseView) {
    requestMobileClose(control.dataset.mobileCloseView);
  }
  if (control.dataset.action === "cancel-mobile-close") cancelMobileClose();
  if (control.dataset.action === "confirm-mobile-close") confirmMobileClose();
  if (control.dataset.mobileDestination) {
    const destination = control.dataset.mobileDestination;
    document.body.classList.remove("mobile-more-open");
    if (destination === "workspace") {
      showMobilePane("agent");
      setWorkspaceOpen(true, { focusPane: true });
    } else if (destination === "agent") {
      setWorkspaceOpen(false);
      showMobilePane("agent");
    } else if (destination === "more") {
      document.body.classList.add("mobile-more-open");
      renderMobileViewBar();
    } else {
      setWorkspaceOpen(false);
      activateView(destination);
      showMobilePane("work");
    }
  }
  if (control.dataset.mobileView) {
    document.body.classList.remove("mobile-more-open");
    setWorkspaceOpen(false);
    activateView(control.dataset.mobileView);
    showMobilePane("work");
  }
  if (control.dataset.view) activateView(control.dataset.view);
  if (control.dataset.action === "toggle-sidebar") {
    setWorkspaceOpen(!interaction.workspaceOpen);
  }
  if (control.dataset.action === "close-sidebar") setWorkspaceOpen(false);
  if (control.dataset.action === "toggle-work") {
    if (isMobile()) showMobilePane("work");
    else setWorkOpen(!interaction.workOpen);
  }
  if (control.dataset.action === "close-view")
    closeView(control.dataset.closeView);
  if (control.dataset.action === "request-preview-attention")
    requestAttention("browser");
  if (control.dataset.action === "reset-interaction-state") {
    localStorage.removeItem(prototypeStateKey);
    location.reload();
  }
  if (control.dataset.action === "toggle-tree") {
    if (["file", "changes"].includes(interaction.activeView)) {
      interaction.drawers[interaction.activeView] =
        !interaction.drawers[interaction.activeView];
      syncDrawer();
      saveInteractionState();
    }
  }
  if (control.dataset.action === "show-agent") showMobilePane("agent");
  if (control.dataset.action === "show-work") showMobilePane("work");
  if (control.dataset.action === "show-workspace") {
    showMobilePane("agent");
    setWorkspaceOpen(true, { focusPane: true });
    document.querySelectorAll(".mobile-switcher button").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.action === "show-workspace",
      );
    });
  }
  if (control.dataset.action === "open-new-workspace")
    openNewWorkspace(control.dataset.project);
  if (control.dataset.action === "open-search") openSearch();
  if (control.dataset.action === "toggle-workspace-actions") {
    workspaceActions.hidden = !workspaceActions.hidden;
    control.setAttribute("aria-expanded", String(!workspaceActions.hidden));
  }
  if (control.dataset.action === "prototype-rename-workspace") {
    workspaceActions.hidden = true;
    updateStateNote("Rename now lives in the Workspace title bar");
  }
  if (control.dataset.action === "confirm-delete-workspace") {
    workspaceActions.hidden = true;
    workspaceDeleteDialog.showModal();
  }
  if (control.dataset.action === "open-settings") {
    showSettingsPage("general");
    settingsDialog.showModal();
  }
  if (control.dataset.action === "open-edit-project")
    editProjectDialog.showModal();
  if (control.dataset.action === "close-dialog")
    control.closest("dialog").close();
  if (control.dataset.action === "toggle-project-menu")
    projectMenu.hidden = !projectMenu.hidden;
  if (control.dataset.action === "choose-project")
    selectProject(control.dataset.project);
  if (control.dataset.action === "show-settings-page")
    showSettingsPage(control.dataset.settingsPage);
  if (control.dataset.action === "scroll-project-section") {
    document.querySelectorAll("[data-project-section]").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.projectSection === control.dataset.projectSection,
      );
    });
    document
      .querySelector(
        `[data-project-section-panel="${control.dataset.projectSection}"]`,
      )
      .scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (control.dataset.action === "open-review-comment") {
    const comment = document.querySelector("[data-review-comment]");
    comment.hidden = false;
    comment.querySelector("[data-review-comment-input]").focus();
  }
  if (control.dataset.action === "cancel-review-comment") {
    document.querySelector("[data-review-comment]").hidden = true;
  }
  if (control.dataset.action === "submit-review-comment") {
    const comment = document.querySelector("[data-review-comment]");
    const text = comment.querySelector("[data-review-comment-input]").value;
    const saved = document.createElement("div");
    saved.className = "review-comment-saved";
    saved.textContent = text;
    comment.querySelector(".review-comment-card").replaceChildren(saved);
    document.querySelector("[data-comment-attachment]").hidden = false;
  }
  if (control.dataset.action === "remove-comment-attachment") {
    document.querySelector("[data-comment-attachment]").hidden = true;
  }
  if (control.matches("[data-search-result]")) {
    if (control.dataset.workspace) activateWorkspace(control.dataset.workspace);
    searchDialog.close();
  }
  if (control.dataset.action === "simulate-workspace-ready") {
    const preferred = document.querySelector(
      '.task[data-workspace="prototype-decision-maps"]',
    );
    const row =
      preferred && !preferred.querySelector(".ready-dot")
        ? preferred
        : [...document.querySelectorAll(".task[data-workspace]")].find(
            (task) =>
              !task.classList.contains("current") &&
              !task.querySelector(".ready-dot"),
          );
    if (row) {
      setWorkspaceReady(row.dataset.workspace, true);
      setProjectExpanded(row.dataset.project, true);
      updateStateNote(
        `${row.querySelector(".task-label").textContent.trim()} became Agent ready · Project expanded`,
      );
    }
  }
  if (control.dataset.action === "preview-workspace-loading") {
    document.body.classList.add("workspace-list-loading");
    workspaceTree.setAttribute("aria-busy", "true");
    window.setTimeout(() => {
      document.body.classList.remove("workspace-list-loading");
      workspaceTree.setAttribute("aria-busy", "false");
      updateStateNote("Workspace navigation loaded");
    }, 1400);
  }
  if (control.dataset.action === "jump-latest") {
    document
      .querySelector(".message:last-child")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    control.remove();
  }
});

function showMobilePane(pane) {
  const work = pane === "work";
  document.body.classList.toggle("mobile-work", work);
  if (work && interaction.activeView) {
    mobileIndicators.delete(interaction.activeView);
  }
  if (work) setWorkOpen(true);
  document.querySelectorAll(".mobile-switcher button").forEach((button) => {
    button.classList.toggle("active", button.dataset.action === `show-${pane}`);
  });
  document.body.classList.remove("mobile-more-open");
  renderMobileViewBar();
}

addEventListener("keydown", (event) => {
  const conversationTab = event.target.closest?.("[data-conversation]");
  if (
    conversationTab &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  ) {
    event.preventDefault();
    const conversations = ["primary", "secondary"];
    const current = conversations.indexOf(conversationTab.dataset.conversation);
    const next =
      event.key === "Home"
        ? conversations[0]
        : event.key === "End"
          ? conversations[1]
          : conversations[
              (current +
                (event.key === "ArrowRight" ? 1 : -1) +
                conversations.length) %
                conversations.length
            ];
    activateConversation(next, { focusTab: true });
  }
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (document.body.classList.contains("tree-open")) {
      event.preventDefault();
      interaction.drawers[interaction.activeView] = false;
      syncDrawer();
      saveInteractionState();
      document
        .querySelector(
          `[data-view-panel="${interaction.activeView}"] [data-action="toggle-tree"]`,
        )
        ?.focus();
    } else if (interaction.workspaceOpen && workspaceOverlays()) {
      event.preventDefault();
      setWorkspaceOpen(false);
      workspaceTrigger.focus();
    }
  }
  if (event.metaKey && !event.altKey && event.code === "Backslash") {
    event.preventDefault();
    if (event.shiftKey)
      setWorkOpen(!interaction.workOpen, { focusPane: !interaction.workOpen });
    else
      setWorkspaceOpen(!interaction.workspaceOpen, {
        focusPane: !interaction.workspaceOpen,
      });
  }
  if (event.metaKey && !event.altKey && event.key.toLowerCase() === "n") {
    event.preventDefault();
    openNewWorkspace("atelier");
  }
  if (event.metaKey && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
  }
  if (newWorkspaceDialog.open && event.metaKey && event.altKey) {
    if (event.code === "Quote") selectProject("atelier");
    if (event.code === "Semicolon") selectProject("none");
  }
  if (newWorkspaceDialog.open && event.metaKey && event.key === "Enter") {
    event.preventDefault();
    newWorkspaceDialog.close();
  }
  if (searchDialog.open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const results = visibleSearchResults();
    const current = results.findIndex((result) =>
      result.classList.contains("active"),
    );
    selectSearchResult(current + (event.key === "ArrowDown" ? 1 : -1));
  }
  if (searchDialog.open && event.key === "Enter") {
    event.preventDefault();
    const selected = visibleSearchResults().find((result) =>
      result.classList.contains("active"),
    );
    if (selected?.dataset.workspace) {
      activateWorkspace(selected.dataset.workspace);
    }
    searchDialog.close();
  }
});

function restoreInteractionState() {
  window.scrollTo(0, 0);
  syncProjectState();
  syncWorkspaceReadyState();
  activateWorkspace(interaction.activeWorkspace, {
    focusComposer: false,
    handoff: false,
  });
  interaction.openViews = interaction.openViews.filter((view) =>
    defaultViewOrder.includes(view),
  );
  interaction.order = interaction.order.filter((view) =>
    interaction.openViews.includes(view),
  );
  defaultViewOrder.forEach((view) => {
    if (!interaction.openViews.includes(view)) {
      document.querySelector(`[data-view-shell="${view}"]`)?.remove();
      document.querySelector(`[data-view-panel="${view}"]`)?.remove();
    }
  });
  interaction.order.forEach((view) => reorderView(view, null));
  if (!interaction.openViews.includes(interaction.activeView)) {
    interaction.activeView = interaction.openViews[0] || null;
  }
  if (interaction.workSize)
    setWorkWidth(interaction.workSize, { persist: false });
  else setWorkWidth(main.clientWidth * 0.44, { persist: false });
  syncSidebar();
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    workspaceScroll.scrollTop = interaction.sidebarScroll;
    scrollAgentToNewest({ focusComposer: false });
    requestAnimationFrame(() => window.scrollTo(0, 0));
  });
  syncWorkVisibility();
  if (interaction.activeView)
    activateView(interaction.activeView, { revealWork: false });
  else setWorkOpen(false);
  saveInteractionState();
}

addEventListener("resize", () => {
  if (!isMobile()) document.body.classList.remove("mobile-work");
  syncSidebar();
  setWorkWidth(interaction.workSize || main.clientWidth * 0.44);
});

restoreInteractionState();
renderConversationState();
renderMobileViewBar();
