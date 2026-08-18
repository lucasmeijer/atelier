import type { Locator, Page } from "@playwright/test";

function attributeValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const workspaceRowsSelector = "#workspaces_table_rows > [data-workspace-id]";

export interface NewWorkspace {
  id: string;
  row: Locator;
  select(): Promise<void>;
}

export interface FullscreenTab {
  close(): Promise<void>;
}

export const atelierUi = {
  newWorkspaceButton(page: Page): Locator {
    return page.getByRole("button", { name: "New workspace", exact: true });
  },

  projectPicker(page: Page): Locator {
    return page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Which project to start from?" }) });
  },

  addProjectLink(page: Page): Locator {
    return this.projectPicker(page).getByRole("link", { name: "Add a new project", exact: true });
  },

  editProjectLink(page: Page, projectName: string): Locator {
    return this.projectPicker(page).getByRole("link", { name: `Edit ${projectName}`, exact: true });
  },

  newProjectForm(page: Page): Locator {
    return page.getByRole("form", { name: "Add project", exact: true });
  },

  projectRepositoryForm(page: Page): Locator {
    return page.getByRole("form", { name: "Repository", exact: true });
  },

  newProjectSecretForm(page: Page): Locator {
    return page.getByRole("row", { name: "Add secret", exact: true });
  },

  workspaceRows(page: Page): Locator {
    return page.locator(workspaceRowsSelector);
  },

  workspaceRow(page: Page, workspaceId: string): Locator {
    return page.locator(`${workspaceRowsSelector}[data-workspace-id=${attributeValue(workspaceId)}]`);
  },

  workspaceDetail(page: Page, workspaceId: string): Locator {
    return page.locator(`#workspace_detail > [data-workspace-residency-target="resident"][data-workspace-id=${attributeValue(workspaceId)}]`);
  },

  agentLaunchPrompt(page: Page): Locator {
    return page.locator("#agent_launch_form").getByRole("textbox", { name: "Describe what you want the agent to do… (optional)" });
  },

  currentAgentPrompt(page: Page, tabKey: string): Locator {
    return this.workspaceTabPane(page, tabKey).locator('[data-agent-pane-target="input"]');
  },

  workspaceTab(page: Page, tabKey: string): Locator {
    return page.locator(`button[data-atelier-fullscreen-mode-value="tab"][data-atelier-fullscreen-tab-key-value=${attributeValue(tabKey)}]`).first();
  },

  browserTab(page: Page, tabKey: string): Locator {
    return this.workspaceTab(page, tabKey);
  },

  workspaceTabPane(page: Page, sourceKey: string): Locator {
    return page.locator(`[data-source-tab-key=${attributeValue(sourceKey)}], [data-work-view-source=${attributeValue(sourceKey)}], [data-tab-pane=${attributeValue(sourceKey)}]`).first();
  },

  async waitForNewWorkspace(page: Page, performCreation: () => Promise<void>, options: { timeout?: number } = {}): Promise<NewWorkspace> {
    const before = await this.workspaceRows(page).evaluateAll<string[], HTMLElement>((rows) => rows.map((row) => row.dataset.workspaceId!));
    await performCreation();

    const id = await page.waitForFunction(({ selector, previousIds }) => {
      const previous = new Set(previousIds);
      return [...document.querySelectorAll<HTMLElement>(selector)]
        .map((row) => row.dataset.workspaceId)
        .find((workspaceId): workspaceId is string => Boolean(workspaceId && !previous.has(workspaceId)));
    }, { selector: workspaceRowsSelector, previousIds: before }, { timeout: options.timeout }).then((handle) => handle.jsonValue());

    if (id === undefined) {
      throw new Error("Playwright resolved the new-workspace wait without a workspace ID");
    }

    const row = this.workspaceRow(page, id);
    return {
      id,
      row,
      select: async () => {
        await row.getByRole("link").first().click();
        await this.workspaceDetail(page, id).waitFor({ state: "visible", timeout: options.timeout });
      },
    };
  },

  async openTabFullscreen(page: Page, options: { tabKey: string; timeout?: number }): Promise<FullscreenTab> {
    const tab = this.workspaceTab(page, options.tabKey);
    await tab.click();
    await tab.hover();
    await page.keyboard.press("f");

    const active = page.locator(`[data-atelier-fullscreen-active="true"][data-source-tab-key=${attributeValue(options.tabKey)}]`);
    await active.waitFor({ state: "visible", timeout: options.timeout });

    return {
      close: async () => {
        await page.getByRole("toolbar", { name: "Fullscreen controls", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
        await active.waitFor({ state: "detached", timeout: options.timeout });
      },
    };
  },
};
