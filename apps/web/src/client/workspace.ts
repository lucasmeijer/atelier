/// <reference lib="dom" />

import { createAgentChatController, startAgentTab } from "@atelier/agent/client";
import { createTerminalPaneController, createTerminalThemeController, initializeTerminalTheme, startTerminal, startTerminalTab } from "@atelier/terminal/client";

declare global {
  interface Window {
    Stimulus: {
      Application: { start(): { register(identifier: string, controllerConstructor: unknown): void; getControllerForElementAndIdentifier(element: Element, identifier: string): unknown } };
      Controller: new (...args: unknown[]) => { element: Element };
    };
  }
}

const { Application, Controller } = window.Stimulus;

initializeTerminalTheme();

class WorkspaceTabsController extends Controller {
  static values = { workspaceId: String };
  declare readonly element: HTMLElement;
  declare readonly workspaceIdValue: string;

  connect(): void {
    const activeTerminal = document.querySelector<HTMLElement>(".tab-pane.active[data-tab-pane^='terminal:']");
    const title = activeTerminal?.dataset.tabPane?.slice("terminal:".length);
    if (title) void startTerminal(this.workspaceIdValue, title);
  }

  activate(event: Event & { params?: { tab?: string } }): void {
    const tabName = event.params?.tab ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget.dataset.tab : undefined);
    if (!tabName) return;
    this.activateTab(tabName);
  }

  stopPropagation(event: Event): void {
    event.stopPropagation();
  }

  activateTab(tabName: string): void {
    this.element.querySelectorAll<HTMLElement>(".tab[data-tab]").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === tabName);
      tab.classList.toggle("muted", tab.dataset.tab !== tabName);
    });
    document.querySelectorAll<HTMLElement>(".tab-pane[data-tab-pane]").forEach((pane) => {
      pane.classList.toggle("active", pane.dataset.tabPane === tabName);
    });

    startTerminalTab(this.workspaceIdValue, tabName);
    startAgentTab(application, tabName);
  }
}

class ActivateTabController extends Controller {
  static values = { tab: String };
  declare readonly element: HTMLElement;
  declare readonly tabValue: string;

  connect(): void {
    const tabs = document.querySelector<HTMLElement>('[data-controller~="workspace-tabs"]');
    const controller = tabs ? application.getControllerForElementAndIdentifier(tabs, "workspace-tabs") as WorkspaceTabsController | null : null;
    controller?.activateTab(this.tabValue);
    this.element.remove();
  }
}

class ModalController extends Controller {
  static values = { autoShow: Boolean };
  declare readonly element: HTMLDialogElement;
  declare readonly autoShowValue: boolean;

  connect(): void {
    if (this.autoShowValue && !this.element.open) this.element.showModal();
  }

  close(): void {
    this.element.close();
  }
}

class ModalOpenerController extends Controller {
  static values = { targetId: String };
  declare readonly element: HTMLElement;
  declare readonly targetIdValue: string;

  open(): void {
    const dialog = document.getElementById(this.targetIdValue) as HTMLDialogElement | null;
    if (dialog && !dialog.open) dialog.showModal();
  }
}

class RedirectController extends Controller {
  static values = { url: String };
  declare readonly element: HTMLElement;
  declare readonly urlValue: string;

  connect(): void {
    location.href = this.urlValue;
  }
}

class GlobalFilterController extends Controller {
  declare readonly element: HTMLInputElement;
  filter(): void {
    const q = this.element.value.toLowerCase();
    document.querySelectorAll<HTMLElement>(".table .row:not(.head)").forEach((row) => {
      row.style.display = row.textContent?.toLowerCase().includes(q) ? "" : "none";
    });
  }
}

const application = Application.start();
application.register("workspace-tabs", WorkspaceTabsController);
application.register("terminal-pane", createTerminalPaneController(Controller));
application.register("terminal-theme", createTerminalThemeController(Controller));
application.register("agent-chat", createAgentChatController(Controller));
application.register("activate-tab", ActivateTabController);
application.register("modal", ModalController);
application.register("modal-opener", ModalOpenerController);
application.register("redirect", RedirectController);
application.register("global-filter", GlobalFilterController);
