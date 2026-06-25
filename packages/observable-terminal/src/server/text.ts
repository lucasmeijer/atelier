export function normalizeCarriageReturns(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^.*\r/gm, "");
}

function isCsiParameter(code: number): boolean {
  return code >= 0x30 && code <= 0x3f;
}

function isIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isFinal(code: number): boolean {
  return code >= 0x30 && code <= 0x7e;
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function consumeCsi(text: string, offset: number): number {
  let index = offset;
  while (index < text.length && isCsiParameter(text.charCodeAt(index))) index++;
  while (index < text.length && isIntermediate(text.charCodeAt(index))) index++;
  return index < text.length && isCsiFinal(text.charCodeAt(index)) ? index + 1 : index;
}

function consumeStringControl(text: string, offset: number): number {
  let index = offset;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x07) return index + 1; // BEL terminates OSC.
    if (code === 0x9c) return index + 1; // ST.
    if (code === 0x1b && text[index + 1] === "\\") return index + 2; // ESC \\ ST.
    index++;
  }
  return index;
}

function consumeEscape(text: string, offset: number): number {
  const next = text.charCodeAt(offset + 1);
  if (Number.isNaN(next)) return offset + 1;
  if (next === 0x5b) return consumeCsi(text, offset + 2); // ESC [ CSI.
  if (next === 0x5d) return consumeStringControl(text, offset + 2); // ESC ] OSC.
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) return consumeStringControl(text, offset + 2); // DCS/SOS/PM/APC.

  let index = offset + 1;
  while (index < text.length && isIntermediate(text.charCodeAt(index))) index++;
  return index < text.length && isFinal(text.charCodeAt(index)) ? index + 1 : index;
}

export function stripTerminalControls(text: string): string {
  const normalized = normalizeCarriageReturns(text);
  let output = "";
  for (let index = 0; index < normalized.length;) {
    const code = normalized.charCodeAt(index);
    if (code === 0x1b) {
      index = consumeEscape(normalized, index);
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(normalized, index + 1);
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeStringControl(normalized, index + 1);
      continue;
    }
    if ((code < 0x20 && normalized[index] !== "\n" && normalized[index] !== "\t") || (code >= 0x80 && code <= 0x9f)) {
      index++;
      continue;
    }
    output += normalized[index];
    index++;
  }
  return output;
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
