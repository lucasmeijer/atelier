import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, defaultHighlightStyle } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { languageExtension } from "../src/client/editor-language.ts";

/** Exercise the editor's parser and tokenization without mounting an EditorView. */
export function highlightEditorSource(path: string, text: string): void {
  const state = EditorState.create({ doc: text, extensions: [languageExtension(path)] });
  const tree = ensureSyntaxTree(state, text.length, 10_000);
  if (!tree || tree.length !== text.length) throw new Error("Editor did not parse the complete fixture");
  let spans = 0;
  highlightTree(tree, defaultHighlightStyle, () => { spans++; });
  if (spans === 0) throw new Error("Editor produced no highlighted spans");
}
