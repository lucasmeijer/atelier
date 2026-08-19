const terminalViewPrefix = "terminal:";

export function terminalViewKey(id: string): string {
  return `${terminalViewPrefix}${id}`;
}

export function terminalIdFromViewKey(viewKey: string): string | undefined {
  if (!viewKey.startsWith(terminalViewPrefix)) return undefined;
  return viewKey.slice(terminalViewPrefix.length) || undefined;
}
