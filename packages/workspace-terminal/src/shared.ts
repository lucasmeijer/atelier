export const terminalTabPrefix = "terminal:";

export function terminalTabKey(title: string): string {
  return `${terminalTabPrefix}${title}`;
}

export function terminalTitleFromTabKey(tabKey: string): string | undefined {
  if (!tabKey.startsWith(terminalTabPrefix)) return undefined;
  return tabKey.slice(terminalTabPrefix.length) || undefined;
}
