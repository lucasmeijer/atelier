export function normalizeCarriageReturns(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^.*\r/gm, "");
}

export function stripTerminalControls(text: string): string {
  return normalizeCarriageReturns(text)
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\u001b[()][0-9A-B]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function stripObservablePaneFraming(text: string): string {
  let output = text.replace(/[ \t\r\n]*$/, "");
  for (;;) {
    const lastNewline = Math.max(output.lastIndexOf("\n"), output.lastIndexOf("\r"));
    const line = lastNewline >= 0 ? output.slice(lastNewline + 1) : output;
    const plainLine = stripTerminalControls(line).trim();
    if (!/^Pane is dea(?:d)?$/.test(plainLine)) return output;
    output = lastNewline >= 0 ? output.slice(0, lastNewline) : "";
    output = output.replace(/[ \t\r\n]*$/, "");
  }
}
