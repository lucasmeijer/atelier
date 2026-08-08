import { describe, expect, test } from "bun:test";
import { parseObservableTerminalMessage } from "../../src/shared/index.ts";

describe("observable terminal control messages", () => {
  test("parses resize messages at the JSON boundary", () => {
    expect(parseObservableTerminalMessage('{"type":"resize","cols":120,"rows":30}')).toEqual({ type: "resize", cols: 120, rows: 30 });
  });

  test("parses progress messages at the JSON boundary", () => {
    expect(parseObservableTerminalMessage('{"type":"progress","state":2,"value":0.5}')).toEqual({ type: "progress", state: 2, value: 0.5 });
    expect(parseObservableTerminalMessage('{"type":"progress","state":4}')).toEqual({ type: "progress", state: 4, value: undefined });
  });

  test("rejects values that do not match a control-message domain type", () => {
    expect(parseObservableTerminalMessage("not json")).toBeUndefined();
    expect(parseObservableTerminalMessage("null")).toBeUndefined();
    expect(parseObservableTerminalMessage('{"type":"resize","cols":"120","rows":30}')).toBeUndefined();
    expect(parseObservableTerminalMessage('{"type":"progress","state":5}')).toBeUndefined();
    expect(parseObservableTerminalMessage('{"type":"progress","state":1,"value":"0.5"}')).toBeUndefined();
  });
});
