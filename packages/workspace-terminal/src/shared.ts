export const terminalTabPrefix = "terminal:";

export function terminalTabKey(title: string): string {
  return `${terminalTabPrefix}${title}`;
}

export function terminalTitleFromTabKey(tabKey: string): string | undefined {
  return tabKey.startsWith(terminalTabPrefix) ? tabKey.slice(terminalTabPrefix.length) : undefined;
}
