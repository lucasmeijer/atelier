import { describe, expect, test } from "bun:test";
import { defaultHighlightStyle, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { languageExtension } from "../src/client/editor-language.ts";

function highlightedTokens(path: string, code: string): string[] {
  const state = EditorState.create({ doc: code, extensions: [languageExtension(path)] });
  const tokens: string[] = [];
  highlightTree(syntaxTree(state), defaultHighlightStyle, (from, to) => tokens.push(code.slice(from, to)));
  return tokens;
}

describe("file editor syntax highlighting", () => {
  test("highlights GLSL and HLSL", () => {
    expect(highlightedTokens("shader.frag", "uniform vec3 tint;")).toEqual(["uniform", "vec3"]);
    expect(highlightedTokens("shader.hlsl", "cbuffer Scene { float4 tint; }")).toEqual(["cbuffer", "float4"]);
  });
});
