import { describe, expect, test } from "bun:test";
import { streamingMarkdownStableBoundary } from "../src/streaming-markdown.ts";

describe("streaming Markdown source boundaries", () => {
  test("counts original source offsets with LF, CRLF, CR and Unicode", () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const prefix = `### Unicode 🧑🏽‍💻${newline}${newline}Café and 漢字.${newline}${newline}`;
      expect(streamingMarkdownStableBoundary(`${prefix}Tail`)).toBe(prefix.length);
    }
    expect(streamingMarkdownStableBoundary("Heading\r\n\r\nBody")).toBe(11);
    const mixed = "Heading\r\n\r\nParagraph\r\rAnother\n\n";
    expect(streamingMarkdownStableBoundary(`${mixed}Tail`)).toBe(mixed.length);
  });

  test("does not commit unfinished whitespace-only lines or split CRLF pairs", () => {
    for (const newline of ["\n", "\r\n"]) {
      const paragraph = `Alpha${newline}`;
      for (const suffix of ["", " ", "   ", "\t", " continuation", "\r"]) {
        expect(streamingMarkdownStableBoundary(paragraph + suffix)).toBe(0);
      }
      const completed = `${paragraph} ${newline}`;
      expect(streamingMarkdownStableBoundary(completed)).toBe(completed.length);
      const continuation = `${paragraph} continuation${newline}${newline}`;
      expect(streamingMarkdownStableBoundary(continuation)).toBe(continuation.length);
    }
    expect(streamingMarkdownStableBoundary("Alpha\r\r")).toBe(0);
    expect(streamingMarkdownStableBoundary("Alpha\r\rTail")).toBe(7);
  });

  test("keeps reference uses and definitions in a shared mutable suffix", () => {
    const prefix = "Independent introduction.\n\n";
    for (const suffix of [
      "Read [the guide][guide].\n\n[guide]: https://example.com\n\nLater.\n\n",
      "[guide]: https://example.com\n\nRead [guide].\n\nLater.\n\n",
      "Read [guide][].\n\n[guide]: https://example.com\n\n",
      "![diagram][image]\n\n[image]: /image.png\n\n",
      "[guide]:\n  https://example.com\n  \"Title\"\n\nRead [guide].\n\n",
      "[inline](https://example.com) and literal [brackets].\n\nLater.\n\n",
    ]) {
      expect(streamingMarkdownStableBoundary(prefix + suffix)).toBe(prefix.length);
    }
  });

  test("fenced brackets are independent but references after a fence are not", () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const fence = ["```ts", "const items = [1, 2];", "", "// [not a reference]", "```"].join(newline);
      const prefix = `${fence}${newline}${newline}`;
      expect(streamingMarkdownStableBoundary(`${prefix}Tail`)).toBe(prefix.length);
      expect(streamingMarkdownStableBoundary(`${fence}${newline}[guide]: /guide${newline}${newline}Tail`)).toBe(0);
    }
  });

  test("boundaries never retreat across append-only line and reference prefixes", () => {
    for (const source of [
      "Alpha\n continuation\n\nTail.",
      "### Unicode 🧑🏽‍💻\r\n\r\nCafé\r\n continuation\r\n\r\nTail.",
      "Heading\r\rBody\r\rTail.",
      "Intro\n\n[guide]: /guide\n\nRead [guide].\n\nDone.",
      "Intro\n\nRead [guide].\n\n[guide]: /guide\n\nDone.",
    ]) {
      let prefix = "";
      let previous = 0;
      for (const point of source) {
        prefix += point;
        const boundary = streamingMarkdownStableBoundary(prefix);
        expect(boundary).toBeGreaterThanOrEqual(previous);
        expect(boundary).toBeLessThanOrEqual(prefix.length);
        previous = boundary;
      }
    }
  });
});

describe("streaming Markdown grammar edges", () => {
  test("only ASCII space and tab form blank lines", () => {
    for (const whitespace of ["\u00a0", "\u2003", "\u2028", "\u2029", "\u000b", "\u000c"]) {
      expect(streamingMarkdownStableBoundary(`Alpha\n${whitespace}\nBeta`)).toBe(0);
      const paragraph = `Alpha\n${whitespace}\nBeta\n\n`;
      expect(streamingMarkdownStableBoundary(`${paragraph}Tail`)).toBe(paragraph.length);
    }
    const prefix = "Alpha\n \t \n";
    expect(streamingMarkdownStableBoundary(`${prefix}Beta`)).toBe(prefix.length);
  });

  test("empty list markers keep the entire list in the mutable tail", () => {
    const prefix = "Before.\n\n";
    for (const marker of ["-", "+", "*", "1.", "2)", "123456789."]) {
      for (const indent of ["", " ", "  ", "   "]) {
        const list = `${indent}${marker}\n\n${indent}${marker} Second item\n\nAfter.\n\n`;
        expect(streamingMarkdownStableBoundary(prefix + list)).toBe(prefix.length);
      }
    }
  });

  test("fence closers accept space and tab, not Unicode whitespace", () => {
    for (const marker of ["```", "~~~"]) {
      for (const suffix of ["\u00a0", "\u2003", "\u2028", "\u2029"]) {
        const source = `${marker}text\nfirst\n${marker}${suffix}\n\nstill code\n`;
        expect(streamingMarkdownStableBoundary(source)).toBe(0);
        const closed = `${source}${marker} \t\n\n`;
        expect(streamingMarkdownStableBoundary(`${closed}After.`)).toBe(closed.length);
      }
    }
  });

  test("recognizes Unicode fence info and rejects backticks only in backtick-fence info", () => {
    for (const separator of ["\u2028", "\u2029"]) {
      const source = `\`\`\`text${separator}label\nfirst\n\nsecond\n`;
      expect(streamingMarkdownStableBoundary(source)).toBe(0);
      const closed = `${source}\`\`\`\n\n`;
      expect(streamingMarkdownStableBoundary(`${closed}After.`)).toBe(closed.length);
    }
    const invalid = "```bad`info\nThis is prose.\n\n";
    expect(streamingMarkdownStableBoundary(`${invalid}After.`)).toBe(invalid.length);
    const tilde = "~~~bad`info\nThis is code.\n\n";
    expect(streamingMarkdownStableBoundary(tilde)).toBe(0);
    const closed = `${tilde}~~~\n\n`;
    expect(streamingMarkdownStableBoundary(`${closed}After.`)).toBe(closed.length);
  });
});
