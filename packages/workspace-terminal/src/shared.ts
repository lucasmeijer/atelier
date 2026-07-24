const terminalTabPrefix = "terminal:";

export function terminalTabKey(id: string): string {
  return `${terminalTabPrefix}${id}`;
}

export function terminalIdFromTabKey(tabKey: string): string | undefined {
  if (!tabKey.startsWith(terminalTabPrefix)) return undefined;
  return tabKey.slice(terminalTabPrefix.length) || undefined;
}
