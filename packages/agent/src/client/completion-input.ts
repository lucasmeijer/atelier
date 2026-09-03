const filePathDelimiters = new Set([" ", "\t", "\n", "\r", '"', "'", "="]);

export interface AgentCompletionInput {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
}

function unclosedDoubleQuoteStart(text: string): number | undefined {
  let start: number | undefined;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') continue;
    start = start === undefined ? index : undefined;
  }
  return start;
}

export function fileCompletionPrefix(input: AgentCompletionInput): string {
  const cursor = input.selectionStart ?? 0;
  const lineStart = input.value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const before = input.value.slice(lineStart, cursor);
  const quoteStart = unclosedDoubleQuoteStart(before);
  let prefix: string;
  if (quoteStart !== undefined && (quoteStart === 0 || filePathDelimiters.has(before[quoteStart - 1]) || before[quoteStart - 1] === "@")) {
    const start = quoteStart > 0 && before[quoteStart - 1] === "@" ? quoteStart - 1 : quoteStart;
    prefix = before.slice(start);
  } else {
    let start = before.length;
    while (start > 0 && !filePathDelimiters.has(before[start - 1])) start--;
    prefix = before.slice(start);
  }
  return prefix;
}

function rawFileCompletionQuery(prefix: string): string {
  if (prefix.startsWith('@"')) return prefix.slice(2);
  if (prefix.startsWith("@") || prefix.startsWith('"')) return prefix.slice(1);
  return prefix;
}

export interface AgentCompletionRequest {
  kind: "quick-launch" | "slash-command" | "file";
  query: string;
  mode?: "direct" | "fuzzy";
}

export function agentCompletionRequest(input: AgentCompletionInput, force = false): AgentCompletionRequest | undefined {
  if (force) {
    const prefix = fileCompletionPrefix(input);
    return { kind: "file", query: rawFileCompletionQuery(prefix), mode: prefix.startsWith("@") ? "fuzzy" : "direct" };
  }
  if (input.value === "") return { kind: "quick-launch", query: "" };

  const before = input.value.slice(0, input.selectionStart ?? 0);
  const after = input.value.slice(input.selectionEnd ?? 0);
  if (!after || /^\s/.test(after)) {
    const slash = before.match(/^\/([^/\s]*)$/);
    if (slash) return { kind: "slash-command", query: slash[1] };
  }

  const prefix = fileCompletionPrefix(input);
  return prefix.startsWith("@") ? { kind: "file", query: rawFileCompletionQuery(prefix), mode: "fuzzy" } : undefined;
}

export function insertSlashCommand(option: Pick<HTMLElement, "dataset">, input: AgentCompletionInput): void {
  const trigger = option.dataset.commandTrigger;
  if (!trigger) return;
  const end = input.selectionEnd ?? 0;
  const after = input.value.slice(end);
  input.value = `${trigger} ${after}`;
  input.setSelectionRange(trigger.length + 1, trigger.length + 1);
}

export function insertFileCompletion(option: HTMLElement, input: AgentCompletionInput): void {
  const path = option.dataset.filePath;
  const prefix = fileCompletionPrefix(input);
  if (!path) return;
  const cursor = input.selectionStart ?? 0;
  const start = cursor - prefix.length;
  let after = input.value.slice(input.selectionEnd ?? cursor);
  const atPrefix = prefix.startsWith("@");
  const needsQuotes = prefix.startsWith('"') || prefix.startsWith('@"') || path.includes(" ");
  const value = `${atPrefix ? "@" : ""}${needsQuotes ? `"${path}"` : path}`;
  if (needsQuotes && after.startsWith('"')) after = after.slice(1);
  const directory = option.dataset.fileDirectory === "true";
  const suffix = atPrefix && !directory ? " " : "";
  input.value = `${input.value.slice(0, start)}${value}${suffix}${after}`;
  let nextCursor = start + value.length + suffix.length;
  if (directory && needsQuotes) nextCursor--;
  input.setSelectionRange(nextCursor, nextCursor);
}
