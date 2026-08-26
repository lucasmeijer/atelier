import { describe, expect, test } from "bun:test";
import { controlModifiedTerminalInput, terminalInputForAccessoryKey } from "../../src/client/terminal-controllers.ts";

describe("terminal mobile accessory keys", () => {
  test("maps each accessory key to terminal input", () => {
    expect(terminalInputForAccessoryKey("escape")).toBe("\x1b");
    expect(terminalInputForAccessoryKey("up")).toBe("\x1b[A");
    expect(terminalInputForAccessoryKey("down")).toBe("\x1b[B");
    expect(terminalInputForAccessoryKey("left")).toBe("\x1b[D");
    expect(terminalInputForAccessoryKey("right")).toBe("\x1b[C");
  });

  test("turns one native keyboard character into control input", () => {
    expect(controlModifiedTerminalInput("c")).toBe("\x03");
    expect(controlModifiedTerminalInput("X")).toBe("\x18");
    expect(controlModifiedTerminalInput("[")).toBe("\x1b");
    expect(controlModifiedTerminalInput("?")).toBe("\x7f");
    expect(controlModifiedTerminalInput(" ")).toBe("\x00");
    expect(controlModifiedTerminalInput("é")).toBe("é");
  });

});
