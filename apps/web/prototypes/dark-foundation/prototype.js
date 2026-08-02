function activateView(view) {
  document.querySelectorAll("[data-view]").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    if (active) tab.querySelector(".attention-dot")?.remove();
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view;
  });
  document.querySelector("[data-nav-title]").textContent =
    view === "changes" ? "Changed files" : "Files";
  document.body.classList.remove("tree-open", "work-hidden");
}

function showMobilePane(pane) {
  const work = pane === "work";
  document.body.classList.toggle("mobile-work", work);
  document.body.classList.remove("work-hidden");
  document.querySelectorAll(".mobile-switcher button").forEach((button) => {
    button.classList.toggle("active", button.dataset.action === `show-${pane}`);
  });
}

const divider = document.querySelector(".divider");
const main = document.querySelector(".main");
let resizingWork = false;

function resizeWork(clientX) {
  const bounds = main.getBoundingClientRect();
  main.style.setProperty("--work-size", `${bounds.right - clientX}px`);
}

divider.addEventListener("pointerdown", (event) => {
  if (matchMedia("(max-width: 760px)").matches) return;
  resizingWork = true;
  document.body.classList.add("resizing-work");
  resizeWork(event.clientX);
});

addEventListener("pointermove", (event) => {
  if (!resizingWork) return;
  resizeWork(event.clientX);
});

function finishWorkResize() {
  resizingWork = false;
  document.body.classList.remove("resizing-work");
}

addEventListener("pointerup", finishWorkResize);
addEventListener("pointercancel", finishWorkResize);

divider.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const width = document.querySelector(".work").getBoundingClientRect().width;
  const delta = event.key === "ArrowLeft" ? 24 : -24;
  main.style.setProperty("--work-size", `${width + delta}px`);
});

const newWorkspaceDialog = document.querySelector("#new-workspace-dialog");
const searchDialog = document.querySelector("#search-dialog");
const settingsDialog = document.querySelector("#settings-dialog");
const editProjectDialog = document.querySelector("#edit-project-dialog");
const projectMenu = document.querySelector("[data-project-menu]");

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

function sidebarIsOpen() {
  return matchMedia("(max-width: 1160px)").matches
    ? document.body.classList.contains("sidebar-open")
    : !document.body.classList.contains("sidebar-hidden");
}

function syncSidebarButton() {
  const open = sidebarIsOpen();
  const button = document.querySelector(".sidebar-trigger");
  button.setAttribute("aria-label", open ? "Hide sidebar" : "Show sidebar");
  button.title = open ? "Hide sidebar" : "Show sidebar";
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
  const selected = results[(index + results.length) % results.length];
  results.forEach((result) =>
    result.classList.toggle("active", result === selected),
  );
  selected?.scrollIntoView({ block: "nearest" });
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

document.querySelectorAll(".prototype-dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

document.addEventListener("click", (event) => {
  const control = event.target.closest("button, [data-action]");
  if (!control) return;
  if (control.dataset.view) activateView(control.dataset.view);
  if (control.dataset.action === "toggle-sidebar") {
    const overlays = matchMedia("(max-width: 1160px)").matches;
    if (overlays) document.body.classList.toggle("sidebar-open");
    else document.body.classList.toggle("sidebar-hidden");
    syncSidebarButton();
  }
  if (control.dataset.action === "close-sidebar") {
    document.body.classList.remove("sidebar-open");
    syncSidebarButton();
  }
  if (control.dataset.action === "toggle-work")
    document.body.classList.toggle("work-hidden");
  if (control.dataset.action === "toggle-tree")
    document.body.classList.toggle("tree-open");
  if (control.dataset.action === "show-agent") showMobilePane("agent");
  if (control.dataset.action === "show-work") showMobilePane("work");
  if (control.dataset.action === "open-new-workspace")
    openNewWorkspace(control.dataset.project);
  if (control.dataset.action === "open-search") openSearch();
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
    document
      .querySelectorAll("[data-project-section]")
      .forEach((button) =>
        button.classList.toggle(
          "active",
          button.dataset.projectSection === control.dataset.projectSection,
        ),
      );
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
  if (control.dataset.action === "cancel-review-comment")
    document.querySelector("[data-review-comment]").hidden = true;
  if (control.dataset.action === "submit-review-comment") {
    const comment = document.querySelector("[data-review-comment]");
    const text = comment.querySelector("[data-review-comment-input]").value;
    const card = comment.querySelector(".review-comment-card");
    const saved = document.createElement("div");
    saved.className = "review-comment-saved";
    saved.textContent = text;
    card.replaceChildren(saved);
    document.querySelector("[data-comment-attachment]").hidden = false;
  }
  if (control.dataset.action === "remove-comment-attachment")
    document.querySelector("[data-comment-attachment]").hidden = true;
  if (control.matches("[data-search-result]")) searchDialog.close();
  if (control.dataset.action === "jump-latest") {
    document
      .querySelector(".message:last-child")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    control.remove();
  }
});

addEventListener("keydown", (event) => {
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
  if (
    searchDialog.open &&
    (event.key === "ArrowDown" || event.key === "ArrowUp")
  ) {
    event.preventDefault();
    const results = visibleSearchResults();
    const current = results.findIndex((result) =>
      result.classList.contains("active"),
    );
    selectSearchResult(current + (event.key === "ArrowDown" ? 1 : -1));
  }
  if (searchDialog.open && event.key === "Enter") {
    event.preventDefault();
    searchDialog.close();
  }
});

addEventListener("resize", () => {
  if (!matchMedia("(max-width: 760px)").matches)
    document.body.classList.remove("sidebar-open", "mobile-work");
  syncSidebarButton();
});

syncSidebarButton();
