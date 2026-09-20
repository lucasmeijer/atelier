export type FileTextChange = { from: number; to: number; insert: string };

// Editor offsets use LF-normalized text. Keep untouched separators byte-for-byte,
// including mixed endings; newly inserted lines use the file's first separator.
export function editorText(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

export function editFileText(content: string, changes: readonly FileTextChange[]): string {
  const separator = content.match(/\r\n?|\n/)?.[0] ?? "\n";
  const offsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\r" && content[i + 1] === "\n") i++;
    offsets.push(i + 1);
  }
  let result = "";
  let position = 0;
  for (const change of changes) {
    result += content.slice(position, offsets[change.from]) + change.insert.replace(/\r\n?|\n/g, separator);
    position = offsets[change.to]!;
  }
  return result + content.slice(position);
}
