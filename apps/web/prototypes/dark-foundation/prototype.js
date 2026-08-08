// Settled prototype: Open views is the sole mobile navigation model.
const prototypeStateKey = "atelier-dark-foundation-desktop-v4";
history.scrollRestoration = "manual";
window.scrollTo(0, 0);
const prototypeUrl = new URL(location.href);
prototypeUrl.searchParams.delete("mobile-nav");
prototypeUrl.searchParams.delete("agent-tabs");
history.replaceState(null, "", prototypeUrl);
const defaultViewOrder = [
  "file",
  "file-context",
  "browser",
  "changes",
  "terminal",
];
const defaultExpandedProjects = {
  atelier: true,
  fastpaperwork: false,
  wayfinder: true,
  sandbox: true,
  none: true,
  parked: false,
};
const defaultParkedWorkspaces = ["mobile-navigation", "bun-upgrade"];
const main = document.querySelector(".main");
const workPane = document.querySelector(".work");
const workTabs = document.querySelector(".work-tabs");
const divider = document.querySelector(".divider");
const workspaceTrigger = document.querySelector(".sidebar-trigger");
const workspaceScroll = document.querySelector("[data-workspace-scroll]");
const workspaceTree = document.querySelector("[data-workspace-tree]");
const workTrigger = document.querySelector(".work-trigger");
const documentViewIds = ["file", "file-context", "browser", "terminal"];
const mobileViewDetails = {
  file: { label: "work-view.ts", icon: "file" },
  "file-context": { label: "CONTEXT.md", icon: "file" },
  browser: { label: "Preview", icon: "browser" },
  changes: { label: "Changes", icon: "git" },
  terminal: { label: "Terminal", icon: "terminal" },
};
const mobileIndicators = new Set(["browser", "changes"]);
let pendingMobileCloseView = null;
const readOnlyPrototypeFiles = new Set();
let conversationState = {
  multiple: false,
  active: "primary",
  secondaryTitle: "Untitled",
};

const slashCommands = [
  { trigger: "/name", args: "[workspace-name]", description: "Rename this workspace, using AI when no name is provided.", kind: "command" },
  { trigger: "/new", args: "", description: "Start a new agent session in this tab.", kind: "command" },
  { trigger: "/land", args: "", description: "Commit, push, and delete this workspace when successful.", kind: "prompt" },
  { trigger: "/review-prototype", args: "[focus]", description: "Review this prototype against its accepted interaction decisions.", kind: "workspace prompt" },
  { trigger: "/skill:grilling", args: "", description: "Stress-test a plan, decision, or interaction proposal.", kind: "skill" },
  { trigger: "/skill:prototype", args: "", description: "Build a throwaway prototype to answer a design question.", kind: "skill" },
  { trigger: "/skill:research", args: "", description: "Investigate a question against high-trust primary sources.", kind: "skill" },
];
const agentComposer = document.querySelector("[data-agent-composer]");
const slashMenu = document.querySelector("[data-slash-menu]");
const queueList = document.querySelector("[data-queue-list]");
const steeredMessages = document.querySelector("[data-steered-messages]");
const toolFullscreen = document.querySelector("[data-tool-fullscreen]");
let queuedMessages = [];
let nextQueuedMessageId = 1;
let slashSelection = 0;
let visibleSlashCommands = [];

function escaped(text) {
  const node = document.createElement("span");
  node.textContent = text;
  return node.innerHTML;
}

function renderQueue() {
  queueList.hidden = queuedMessages.length === 0;
  queueList.innerHTML = queuedMessages
    .map((message) => `<div class="queued-message" data-queued-message="${message.id}"><span class="queued-message-copy">${escaped(message.text)}</span><button class="queue-steer" data-action="steer-queued-message" data-queue-id="${message.id}">Steer</button><button class="icon small" data-action="delete-queued-message" data-queue-id="${message.id}" aria-label="Delete queued message"><svg><use href="#x" /></svg></button></div>`)
    .join("");
}

function renderSlashMenu(query) {
  const normalized = query.slice(1).toLowerCase();
  visibleSlashCommands = slashCommands
    .filter((command) => command.trigger.slice(1).toLowerCase().includes(normalized))
    .sort((a, b) => Number(b.trigger.slice(1).startsWith(normalized)) - Number(a.trigger.slice(1).startsWith(normalized)) || a.trigger.localeCompare(b.trigger));
  slashSelection = Math.min(slashSelection, Math.max(0, visibleSlashCommands.length - 1));
  slashMenu.innerHTML = visibleSlashCommands.length
    ? visibleSlashCommands.map((command, index) => `<button class="slash-option${index === slashSelection ? " active" : ""}" role="option" aria-selected="${index === slashSelection}" data-action="select-slash-command" data-command-index="${index}"><span class="slash-trigger">${escaped(command.trigger)}${command.args ? ` ${escaped(command.args)}` : ""}</span><span class="slash-kind">${escaped(command.kind)}</span><span class="slash-description">${escaped(command.description)}</span></button>`).join("")
    : `<div class="slash-option"><span class="slash-description">No slash commands</span></div>`;
  slashMenu.hidden = false;
  slashMenu.querySelector(".slash-option.active")?.scrollIntoView({ block: "nearest" });
}

function dismissSlashMenu() {
  slashMenu.hidden = true;
  visibleSlashCommands = [];
}

function selectSlashCommand(index) {
  const command = visibleSlashCommands[index];
  agentComposer.value = `${command.trigger}${command.args ? " " : ""}`;
  dismissSlashMenu();
  agentComposer.focus();
}

function submitAgentMessage() {
  const text = agentComposer.value.trim();
  if (!text) return;
  queuedMessages.push({ id: nextQueuedMessageId++, text });
  agentComposer.value = "";
  dismissSlashMenu();
  renderQueue();
  updateStateNote("Message queued while Agent is running");
}

function removeQueuedMessage(id, { steer = false } = {}) {
  const message = queuedMessages.find((candidate) => candidate.id === id);
  queuedMessages = queuedMessages.filter((candidate) => candidate.id !== id);
  renderQueue();
  if (!steer) {
    updateStateNote("Queued message deleted");
    agentComposer.focus();
    return;
  }
  const article = document.createElement("article");
  article.className = "message user";
  const copy = document.createElement("p");
  copy.textContent = message.text;
  article.append(copy);
  steeredMessages.before(article);
  article.scrollIntoView({ behavior: "smooth", block: "center" });
  updateStateNote("Queued message steered into the active run");
}

agentComposer.addEventListener("input", () => {
  slashSelection = 0;
  if (/^\/\S*$/.test(agentComposer.value)) renderSlashMenu(agentComposer.value);
  else dismissSlashMenu();
});

agentComposer.addEventListener("keydown", (event) => {
  if (!slashMenu.hidden && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    if (visibleSlashCommands.length === 0) return;
    slashSelection = (slashSelection + (event.key === "ArrowDown" ? 1 : -1) + visibleSlashCommands.length) % visibleSlashCommands.length;
    renderSlashMenu(agentComposer.value);
    return;
  }
  if (!slashMenu.hidden && event.key === "Escape") {
    event.preventDefault();
    dismissSlashMenu();
    return;
  }
  if (!slashMenu.hidden && event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    selectSlashCommand(slashSelection);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitAgentMessage();
  }
});

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
    workspaceHistory: Array.isArray(saved?.workspaceHistory)
      ? saved.workspaceHistory
      : ["redesign-tabs"],
    parkedWorkspaces: Array.isArray(saved?.parkedWorkspaces)
      ? saved.parkedWorkspaces
      : [...defaultParkedWorkspaces],
    sidebarScroll: saved?.sidebarScroll ?? 0,
    readyWorkspaces: Array.isArray(saved?.readyWorkspaces)
      ? saved.readyWorkspaces
      : ["persisted-work-views", "extract-invoices"],
  };
}

let interaction = loadInteractionState();
let resizingWork = false;
let draggedView = null;
const workspaceOrigins = new Map(
  [...document.querySelectorAll(".task[data-workspace]")].map((row, order) => [
    row.dataset.workspace,
    { container: row.parentElement, order },
  ]),
);

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
    ) && !isWorkspaceParked(row.dataset.workspace);
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
  syncParkedGroupState();
}

function setWorkspaceReady(workspace, ready) {
  interaction.readyWorkspaces = interaction.readyWorkspaces.filter(
    (candidate) => candidate !== workspace,
  );
  if (ready) interaction.readyWorkspaces.push(workspace);
  syncWorkspaceReadyState();
  saveInteractionState();
}

function isWorkspaceParked(workspace) {
  return interaction.parkedWorkspaces.includes(workspace);
}

function workspaceProjectLabel(row) {
  if (row.dataset.project === "none") return "No project";
  return projectGroup(row.dataset.project)
    .querySelector(".project-name")
    .textContent.trim();
}

function syncParkedGroupState() {
  const group = document.querySelector("[data-parked-group]");
  const parkedRows = [...document.querySelectorAll(".task.parked[data-workspace]")];
  group.hidden = parkedRows.length === 0;
  group.querySelector("[data-parked-count]").textContent = String(
    parkedRows.length,
  );
}

function syncWorkspacePlacement() {
  const parkedContainer = document.querySelector("[data-parked-workspaces]");
  workspaceOrigins.forEach(({ container }, workspace) => {
    const row = document.querySelector(
      `.task[data-workspace="${workspace}"]`,
    );
    const parked = isWorkspaceParked(workspace);
    row.classList.toggle("parked", parked);
    row.title = parked ? "Unpark and open workspace" : "";
    let project = row.querySelector(".parked-project");
    if (parked) {
      if (!project) {
        project = document.createElement("span");
        project.className = "parked-project";
        row.querySelector(".workspace-status").before(project);
      }
      project.textContent = workspaceProjectLabel(row);
      parkedContainer.append(row);
    } else {
      project?.remove();
      container.append(row);
    }
    document
      .querySelectorAll(`[data-workspace-search-state="${workspace}"]`)
      .forEach((state) => {
        state.textContent = `${workspaceProjectLabel(row)}${parked ? " · Parked" : ""}`;
      });
  });

  const byOriginalOrder = (left, right) =>
    workspaceOrigins.get(left.dataset.workspace).order -
    workspaceOrigins.get(right.dataset.workspace).order;
  document
    .querySelectorAll(".project-group .project-workspaces")
    .forEach((container) => {
      [...container.querySelectorAll(":scope > .task")]
        .sort(byOriginalOrder)
        .forEach((row) => container.append(row));
    });
  [...parkedContainer.querySelectorAll(":scope > .task")]
    .sort(byOriginalOrder)
    .forEach((row) => parkedContainer.append(row));
  syncParkedGroupState();
}

function workspaceAfterParking(workspace) {
  const parkedRow = document.querySelector(
    `.task[data-workspace="${workspace}"]`,
  );
  const candidates = [...workspaceOrigins.keys()].filter(
    (candidate) => !isWorkspaceParked(candidate) && candidate !== workspace,
  );
  const history = [...interaction.workspaceHistory].reverse();
  return (
    history.find(
      (candidate) =>
        candidates.includes(candidate) &&
        document.querySelector(`.task[data-workspace="${candidate}"]`).dataset
          .project === parkedRow.dataset.project,
    ) ??
    history.find((candidate) => candidates.includes(candidate)) ??
    candidates.find(
      (candidate) =>
        document.querySelector(`.task[data-workspace="${candidate}"]`).dataset
          .project === parkedRow.dataset.project,
    ) ??
    candidates[0]
  );
}

function setWorkspaceParked(workspace, parked, { activate = true } = {}) {
  interaction.parkedWorkspaces = interaction.parkedWorkspaces.filter(
    (candidate) => candidate !== workspace,
  );
  if (parked) interaction.parkedWorkspaces.push(workspace);
  const nextWorkspace = parked ? workspaceAfterParking(workspace) : workspace;
  syncWorkspacePlacement();

  const row = document.querySelector(`.task[data-workspace="${workspace}"]`);
  const title = row.querySelector(".task-label").textContent.trim();
  if (parked) {
    setProjectExpanded("parked", true);
    if (interaction.activeWorkspace === workspace && nextWorkspace) {
      activateWorkspace(nextWorkspace);
    } else if (interaction.activeWorkspace === workspace) {
      clearActiveWorkspace();
    }
    updateStateNote(
      nextWorkspace
        ? `${title} parked · selection moved to another workspace`
        : `${title} parked · no active workspace`,
    );
  } else {
    setProjectExpanded(row.dataset.project, true);
    if (activate) activateWorkspace(workspace);
    updateStateNote(`${title} unparked · workspace activated`);
  }
  saveInteractionState();
}

function clearActiveWorkspace() {
  document.querySelectorAll(".task.current").forEach((task) => {
    task.classList.remove("current");
  });
  interaction.activeWorkspace = null;
  document.querySelector("[data-workspace-title]").textContent =
    "No active workspace";
  document.querySelector("[data-workspace-project]").textContent = "";
  document.querySelector("[data-no-active-workspace]").hidden = false;
  document.querySelector(".workspace-title-actions").hidden = true;
  if (isMobile()) setWorkspaceOpen(true, { focusPane: true });
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
  const wasParked = isWorkspaceParked(workspace);
  if (wasParked) setWorkspaceParked(workspace, false, { activate: false });
  document.querySelector("[data-no-active-workspace]").hidden = true;
  document.querySelector(".workspace-title-actions").hidden = false;
  const changed = interaction.activeWorkspace !== workspace;
  const project = row.dataset.project;
  setProjectExpanded(project, true);
  document.querySelectorAll(".task[data-workspace]").forEach((task) => {
    task.classList.toggle("current", task === row);
  });
  interaction.activeWorkspace = workspace;
  interaction.workspaceHistory = interaction.workspaceHistory.filter(
    (candidate) => candidate !== workspace,
  );
  interaction.workspaceHistory.push(workspace);
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
  updateStateNote(
    wasParked
      ? `${title} unparked · newest message · composer focused`
      : `${title} · newest message · composer focused`,
  );
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
  const supportsDrawer = ["file", "file-context", "changes"].includes(
    interaction.activeView,
  );
  document.body.classList.toggle(
    "tree-open",
    supportsDrawer && interaction.drawers[interaction.activeView],
  );
  document.querySelector("[data-nav-title]").textContent =
    interaction.activeView === "changes" ? "Changed files" : "File navigator";
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
const onboardingDialog = document.querySelector("#onboarding-dialog");
const editProjectDialog = document.querySelector("#edit-project-dialog");
const workspaceDeleteDialog = document.querySelector(
  "#workspace-delete-dialog",
);
const projectMenu = document.querySelector("[data-project-menu]");
const workspaceActions = document.querySelector("[data-workspace-actions]");
let onboardingStep = 0;

function showOnboardingStep(index) {
  onboardingStep = Math.max(0, Math.min(index, 2));
  document.querySelectorAll("[data-onboarding-pane]").forEach((pane) => {
    pane.classList.toggle("visible", Number(pane.dataset.onboardingPane) === onboardingStep);
  });
  document.querySelectorAll("[data-onboarding-step]").forEach((button) => {
    const step = Number(button.dataset.onboardingStep);
    button.classList.toggle("active", step === onboardingStep);
    button.classList.toggle("complete", step < onboardingStep);
  });
  const back = document.querySelector('[data-action="onboarding-back"]');
  const next = document.querySelector('[data-action="onboarding-next"]');
  back.hidden = onboardingStep === 0;
  next.textContent = onboardingStep === 2 ? "Start using Atelier" : "Continue";
}

function syncOnboardingChecklist() {
  const connected = document.querySelector('[data-action="toggle-onboarding-github"]').classList.contains("selected");
  const github = document.querySelector('[data-onboarding-check="github"]');
  github.classList.toggle("complete", connected);
  github.querySelector("i").textContent = connected ? "✓" : "○";
}

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

const navigatorFilter = document.querySelector("[data-navigator-filter]");

function filterNavigator(query) {
  const normalized = query.trim().toLowerCase();
  const entries = [...document.querySelectorAll("[data-nav-entry]")];
  const matches = normalized
    ? entries.filter((entry) => entry.dataset.navSearch.includes(normalized))
    : entries;
  entries.forEach((entry) => {
    entry.hidden =
      normalized.length > 0 &&
      !matches.some(
        (match) =>
          match === entry ||
          match.dataset.navSearch.startsWith(`${entry.dataset.navSearch}/`),
      );
  });
  const visibleFiles = entries.filter(
    (entry) =>
      !entry.hidden && entry.querySelector('use[href="#file"]'),
  ).length;
  document.querySelector("[data-navigator-empty]").hidden = matches.length > 0;
  if (normalized) {
    updateStateNote(
      `${visibleFiles} matching ${visibleFiles === 1 ? "file" : "files"} · parent folders retained`,
    );
  }
}

navigatorFilter.addEventListener("input", (event) => {
  filterNavigator(event.target.value);
});

navigatorFilter.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !event.currentTarget.value) return;
  event.stopPropagation();
  event.currentTarget.value = "";
  filterNavigator("");
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
  if (control.dataset.action === "submit-agent-message") submitAgentMessage();
  if (control.dataset.action === "select-slash-command") {
    selectSlashCommand(Number(control.dataset.commandIndex));
  }
  if (control.dataset.action === "steer-queued-message") {
    removeQueuedMessage(Number(control.dataset.queueId), { steer: true });
  }
  if (control.dataset.action === "delete-queued-message") {
    removeQueuedMessage(Number(control.dataset.queueId));
  }
  if (control.dataset.toolTab) {
    const region = control.closest(".agent-tool-region");
    region.querySelectorAll("[data-tool-tab]").forEach((tab) => tab.classList.toggle("active", tab === control));
    region.querySelectorAll("[data-tool-pane]").forEach((pane) => {
      pane.hidden = pane.dataset.toolPane !== control.dataset.toolTab;
    });
  }
  if (control.dataset.action === "show-more-lines") {
    control.parentElement.querySelector("[data-more-lines]").hidden = false;
    control.remove();
  }
  if (control.dataset.action === "copy-tool-output") {
    const source = control.closest(".agent-tool-region, [data-tool-source]");
    const text = [...source.querySelectorAll("pre:not([hidden])")].map((pre) => pre.textContent).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      control.setAttribute("aria-label", "Copied");
      updateStateNote("Tool output copied");
    });
  }
  if (control.dataset.action === "tool-fullscreen") {
    const source = control.closest(".agent-tool-region, [data-tool-source]");
    const body = toolFullscreen.querySelector("[data-tool-fullscreen-body]");
    const image = source.querySelector("img");
    if (image) body.replaceChildren(image.cloneNode());
    else {
      const pre = document.createElement("pre");
      pre.textContent = [...source.querySelectorAll("pre:not([hidden])")].map((node) => node.textContent).join("\n\n");
      body.replaceChildren(pre);
    }
    toolFullscreen.querySelector("[data-tool-fullscreen-title]").textContent = control.dataset.fullscreenTitle;
    toolFullscreen.showModal();
  }
  if (control.dataset.action === "close-tool-fullscreen") toolFullscreen.close();
  if (control.dataset.fileAction) {
    const file = control.dataset.fileId || "file";
    const status = document.querySelector(`[data-file-status="${file}"]`);
    const action = control.dataset.fileAction;
    if (action === "save-error") {
      status.textContent = "Couldn’t save";
      status.className = "file-editor-status is-error";
      document.querySelector(`[data-file-editor="${file}"] .cm-content`)?.focus();
    }
    if (action === "external-change") {
      status.textContent = "Updated from disk";
      status.className = "file-editor-status is-saved";
      updateStateNote(`${file} refreshed after an agent changed it on disk`);
    }
    if (action === "force-conflict") {
      status.textContent = "Conflict";
      status.className = "file-editor-status is-conflict";
      document.querySelector(`[data-file-conflict="${file}"]`).showModal();
    }
    if (["use-mine", "use-theirs"].includes(action)) {
      document.querySelector(`[data-file-conflict="${file}"]`).close();
      status.textContent = action === "use-mine" ? "Saved mine" : "Using disk version";
      status.className = "file-editor-status is-saved";
      updateStateNote(action === "use-mine" ? "Local version kept and saved" : "Disk version loaded explicitly");
    }
    if (action === "read-only") {
      const readOnly = !readOnlyPrototypeFiles.has(file);
      if (readOnly) readOnlyPrototypeFiles.add(file);
      else readOnlyPrototypeFiles.delete(file);
      document
        .querySelector(`[data-file-editor="${file}"] .cm-content`)
        ?.setAttribute("contenteditable", String(!readOnly));
      control.textContent = readOnly ? "Make writable" : "Read only";
      control.classList.toggle("active", readOnly);
      status.textContent = readOnly ? "Read only" : "Saved";
      status.className = readOnly
        ? "file-editor-status is-readonly"
        : "file-editor-status is-saved";
    }
    if (action === "jump") {
      const line = Number(control.dataset.line);
      const column = Number(control.dataset.column);
      const target = document.querySelectorAll(
        `[data-file-editor="${file}"] .cm-line`,
      )[line - 1];
      target?.scrollIntoView({ block: "center" });
      document.querySelector(`[data-file-location="${file}"]`).textContent =
        `Ln ${line}, Col ${column}`;
      document.querySelector(`[data-file-editor="${file}"] .cm-content`)?.focus();
      updateStateNote(`${file} revealed at line ${line}, column ${column}`);
    }
    if (action === "refresh") {
      status.textContent = "Checking disk…";
      status.className = "file-editor-status is-saving";
      window.setTimeout(() => {
        status.textContent = "Up to date";
        status.className = "file-editor-status is-saved";
      }, 500);
    }
    if (action === "toggle-preview") {
      const host = document.querySelector(`[data-file-editor="${file}"]`);
      const preview = document.querySelector(`[data-markdown-preview="${file}"]`);
      const show = preview.hidden;
      host.hidden = show;
      preview.hidden = !show;
      control.textContent = show ? "Raw" : "Preview";
      control.setAttribute("aria-pressed", String(show));
    }
  }
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
    if (["file", "file-context", "changes"].includes(interaction.activeView)) {
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
  if (control.dataset.action === "park-active-workspace") {
    workspaceActions.hidden = true;
    setWorkspaceParked(interaction.activeWorkspace, true);
  }
  if (control.dataset.action === "confirm-delete-workspace") {
    workspaceActions.hidden = true;
    workspaceDeleteDialog.showModal();
  }
  if (control.dataset.action === "open-settings") {
    showSettingsPage("general");
    settingsDialog.showModal();
  }
  if (control.dataset.action === "onboarding-back") {
    showOnboardingStep(onboardingStep - 1);
  }
  if (control.dataset.action === "onboarding-next") {
    if (onboardingStep === 2) onboardingDialog.close();
    else showOnboardingStep(onboardingStep + 1);
  }
  if (control.dataset.action === "toggle-onboarding-github") {
    const connected = !control.classList.contains("selected");
    control.classList.toggle("selected", connected);
    control.textContent = connected ? "Disconnect" : "Connect";
    syncOnboardingChecklist();
  }
  if (control.dataset.action === "toggle-onboarding-model") {
    const selected = !control.classList.contains("selected");
    control.classList.toggle("selected", selected);
    control.textContent = selected ? "Favorited" : "Favorite";
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
  if (control.dataset.action === "attach-agent-file") {
    const attachment = document.querySelector("[data-agent-attachment]");
    attachment.hidden = false;
    const textarea = control.closest(".composer").querySelector("textarea");
    textarea.value =
      "Review the file at /tmp/atelier-uploads/reference.pdf";
    textarea.focus();
    updateStateNote("Attachment added · prompt receives its workspace path only");
  }
  if (control.dataset.action === "remove-agent-attachment") {
    control.closest("[data-agent-attachment]").hidden = true;
    updateStateNote("Attachment removed before sending");
  }
  if (control.dataset.action === "open-prototype-file") {
    const view = control.dataset.fileView;
    activateView(view);
    if (isMobile()) showMobilePane("work");
    updateStateNote(
      `${control.dataset.canonicalPath} · revealed existing canonical File view`,
    );
  }
  if (control.dataset.action === "navigator-refresh") {
    document
      .querySelector(
        `[data-view-panel="${interaction.activeView}"] [data-file-action="refresh"]`,
      )
      ?.click();
    updateStateNote("File navigator refreshed");
  }
  if (control.dataset.action === "navigator-download") {
    updateStateNote(`${interaction.activeView} · download prepared`);
  }
  if (control.dataset.action === "navigator-copy-url") {
    navigator.clipboard
      .writeText(`atelier://workspace/redesign-tabs/${interaction.activeView}`)
      .then(() => updateStateNote("File URL copied"));
  }
  if (control.dataset.action === "navigator-delete") {
    document.querySelector("#file-delete-dialog").showModal();
  }
  if (control.dataset.action === "confirm-file-delete") {
    document.querySelector("#file-delete-dialog").close();
    const status = document.querySelector(
      `[data-file-status="${interaction.activeView}"]`,
    );
    if (status) {
      status.textContent = "Unavailable";
      status.className = "file-editor-status is-error";
    }
    updateStateNote("File deleted · open File view is now unavailable");
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
  if (control.dataset.action === "simulate-parked-ready") {
    const row = [...document.querySelectorAll(".task.parked[data-workspace]")].find(
      (task) => !interaction.readyWorkspaces.includes(task.dataset.workspace),
    );
    if (row) {
      const title = row.querySelector(".task-label").textContent.trim();
      const project = row.dataset.project;
      setWorkspaceParked(row.dataset.workspace, false, { activate: false });
      setWorkspaceReady(row.dataset.workspace, true);
      setProjectExpanded(project, true);
      updateStateNote(
        `${title} became Agent ready · automatically unparked · Project expanded`,
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
  interaction.parkedWorkspaces
    .filter((workspace) => interaction.readyWorkspaces.includes(workspace))
    .forEach((workspace) => {
      interaction.parkedWorkspaces = interaction.parkedWorkspaces.filter(
        (candidate) => candidate !== workspace,
      );
      const row = document.querySelector(`.task[data-workspace="${workspace}"]`);
      interaction.expandedProjects[row.dataset.project] = true;
    });
  syncWorkspacePlacement();
  syncProjectState();
  syncWorkspaceReadyState();
  if (interaction.activeWorkspace) {
    activateWorkspace(interaction.activeWorkspace, {
      focusComposer: false,
      handoff: false,
    });
  } else {
    clearActiveWorkspace();
  }
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
showOnboardingStep(0);
if (!prototypeUrl.searchParams.has("file-nav")) onboardingDialog.showModal();
