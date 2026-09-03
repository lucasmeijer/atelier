import {
  type WorkspaceClientCommand,
  type WorkspaceClientHooks,
  type WorkspaceClientSurfaceVisibilityContext,
  type WorkspaceClientWorkspaceAppFrameContext,
  type WorkspacePaletteItem,
  type WorkspacePaletteProvider,
  type WorkspacePaletteSearchContext,
} from "@atelier/shared";

class WorkspaceClientHookRegistry implements WorkspaceClientHooks {
  private readonly becomeVisibleHandlers: Array<(context: WorkspaceClientSurfaceVisibilityContext) => void> = [];
  private readonly noLongerVisibleHandlers: Array<(context: WorkspaceClientSurfaceVisibilityContext) => void> = [];
  private readonly workspaceAppFrameUrlHandlers: Array<(context: WorkspaceClientWorkspaceAppFrameContext) => void> = [];
  private readonly workspaceAppFrameRefreshHandlers: Array<(context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void> = [];
  private readonly paletteProviders = new Map<string, WorkspacePaletteProvider>();
  private readonly commands = new Map<string, WorkspaceClientCommand>();

  onBecomeVisible(handler: (context: WorkspaceClientSurfaceVisibilityContext) => void): void { this.becomeVisibleHandlers.push(handler); }
  onNoLongerVisible(handler: (context: WorkspaceClientSurfaceVisibilityContext) => void): void { this.noLongerVisibleHandlers.push(handler); }
  onWorkspaceAppFrameUrl(handler: (context: WorkspaceClientWorkspaceAppFrameContext) => void): void { this.workspaceAppFrameUrlHandlers.push(handler); }
  onWorkspaceAppFrameRefresh(handler: (context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void): void { this.workspaceAppFrameRefreshHandlers.push(handler); }
  registerPaletteProvider(provider: WorkspacePaletteProvider): void { this.paletteProviders.set(provider.id, provider); }
  registerCommand(command: WorkspaceClientCommand): void { this.commands.set(command.id, command); }
  registeredCommands(): WorkspaceClientCommand[] { return [...this.commands.values()]; }

  becomeVisible(context: WorkspaceClientSurfaceVisibilityContext): void {
    this.becomeVisibleHandlers.forEach((handler) => handler(context));
  }

  noLongerVisible(context: WorkspaceClientSurfaceVisibilityContext): void {
    this.noLongerVisibleHandlers.forEach((handler) => handler(context));
  }

  workspaceAppFrameUrl(context: WorkspaceClientWorkspaceAppFrameContext): void {
    this.workspaceAppFrameUrlHandlers.forEach((handler) => handler(context));
  }

  workspaceAppFrameRefresh(context: { appKey: string; frame: HTMLIFrameElement; load(): void }): void {
    this.workspaceAppFrameRefreshHandlers.forEach((handler) => handler(context));
  }

  async searchPalette(query: string): Promise<PaletteResult[]> {
    const context: WorkspacePaletteSearchContext = { query, fuzzyScore: (candidate) => fuzzyScore(query, candidate) };
    const providerItems = await Promise.all([...this.paletteProviders.values()].map(async (provider) => {
      const items = await provider.search(context);
      return items.map((item) => ({ ...item, score: item.score ?? this.paletteItemScore(query, item) }));
    }));
    return providerItems.flat()
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 30);
  }

  private paletteItemScore(query: string, item: WorkspacePaletteItem): number {
    return fuzzyScore(query, [item.title, item.subtitle, item.detail, item.badge, ...(item.keywords ?? [])].filter(Boolean).join(" "));
  }
}

export type PaletteResult = WorkspacePaletteItem & { score: number };

export const clientHooks = new WorkspaceClientHookRegistry();

function fuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 1;
  if (!c) return 0;
  if (c === q) return 1000 + q.length;
  if (c.startsWith(q)) return 900 + q.length;
  const substringIndex = c.indexOf(q);
  if (substringIndex >= 0) return 760 + q.length - substringIndex;
  let score = 0;
  let lastIndex = -1;
  let streak = 0;
  for (const char of q) {
    const index = c.indexOf(char, lastIndex + 1);
    if (index < 0) return 0;
    streak = index === lastIndex + 1 ? streak + 1 : 1;
    score += 12 + streak * 8;
    if (index === 0 || /[\s/:._-]/.test(c[index - 1] ?? "")) score += 18;
    score -= Math.max(0, index - lastIndex - 1) * 0.4;
    lastIndex = index;
  }
  return Math.max(1, score - Math.max(0, c.length - q.length) * 0.05);
}
