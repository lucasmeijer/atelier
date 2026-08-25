import type { Locator, Page } from "@playwright/test";

function attributeValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const workspaceRowsSelector = ".fixed-shell-workspace-row[data-workspace-entry-id]";

export interface NewWorkspace {
  id: string;
  row: Locator;
  select(): Promise<void>;
}

export interface FullscreenView {
  close(): Promise<void>;
}

export const atelierUi = {
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
    return page.locator(`${workspaceRowsSelector}[data-workspace-entry-id=${attributeValue(workspaceId)}]`);
  },

  workspaceDetail(page: Page, workspaceId: string): Locator {
    return page.locator(`#workspace_detail > [data-workspace-residency-target="resident"][data-workspace-id=${attributeValue(workspaceId)}]`);
  },

  agentLaunchPrompt(page: Page): Locator {
    return page.locator("#agent_launch_form").getByRole("textbox", { name: "Describe what you want the agent to do… (optional)" });
  },

  currentAgentPrompt(page: Page, sourceKey: string): Locator {
    return page.locator(`[data-agent-conversation-source=${attributeValue(sourceKey)}]`).locator('[data-agent-pane-target="input"]');
  },

  workspaceView(page: Page, viewKey: string): Locator {
    return page.locator(`button[data-atelier-fullscreen-mode-value="view"][data-atelier-fullscreen-view-key-value=${attributeValue(viewKey)}]`).first();
  },

  browserView(page: Page, viewKey: string): Locator {
    return this.workspaceView(page, viewKey);
  },

  workspaceViewPane(page: Page, sourceKey: string): Locator {
    return page.locator(`[data-source-work-view-key=${attributeValue(sourceKey)}], [data-work-view-source=${attributeValue(sourceKey)}]`).first();
  },

  async waitForNewWorkspace(page: Page, performCreation: () => Promise<void>, options: { timeout?: number } = {}): Promise<NewWorkspace> {
    const before = await this.workspaceRows(page).evaluateAll<string[], HTMLElement>((rows) => rows.map((row) => row.dataset.workspaceEntryId!));
    await performCreation();

    const id = await page.waitForFunction(({ selector, previousIds }) => {
      const previous = new Set(previousIds);
      return [...document.querySelectorAll<HTMLElement>(selector)]
        .map((row) => row.dataset.workspaceEntryId)
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
        await row.click();
        await this.workspaceDetail(page, id).waitFor({ state: "visible", timeout: options.timeout });
      },
    };
  },

  async openViewFullscreen(page: Page, options: { viewKey: string; timeout?: number }): Promise<FullscreenView> {
    const view = this.workspaceView(page, options.viewKey);
    await view.click();
    await view.hover();
    await page.keyboard.press("f");

    const active = page.locator(`[data-atelier-fullscreen-active="true"][data-source-work-view-key=${attributeValue(options.viewKey)}]`);
    await active.waitFor({ state: "visible", timeout: options.timeout });

    return {
      close: async () => {
        await page.getByRole("toolbar", { name: "Fullscreen controls", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
        await active.waitFor({ state: "detached", timeout: options.timeout });
      },
    };
  },
};
