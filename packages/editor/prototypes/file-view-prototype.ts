// PROTOTYPE: real CodeMirror surfaces for deciding File view behavior in issue #3.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Compartment } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

type FileId = "file" | "file-context";

type PrototypeFile = {
  id: FileId;
  path: string;
  initial: string;
  language: ReturnType<typeof javascript> | ReturnType<typeof markdown>;
  view?: EditorView;
  readOnly: Compartment;
  saved: string;
  disk: string;
  saveTimer?: ReturnType<typeof setTimeout>;
  failNextSave: boolean;
  conflictDisk?: string;
};

const source = `export type WorkViewRef =
  | { type: "file"; id: FileViewId }
  | { type: "browser"; id: BrowserViewId }
  | { type: "terminal"; id: TerminalViewId }
  | { type: "changes"; id: ChangesViewId }

export function requestAttention(view: WorkViewRef) {
  attention.mark(view, {
    requestedAt: clock.now(),
    repeatable: true,
  })
}

// Attention clears when this view becomes visible.

export function canonicalFilePath(path: string) {
  return workspace.resolve(path)
}

export function openFile(path: string, line?: number, column?: number) {
  const canonicalPath = canonicalFilePath(path)
  const existing = workViews.findFile(canonicalPath)
  if (existing) return existing.reveal({ line, column })

  return workViews.open({ type: "file", canonicalPath, line, column })
}

export function refreshFile(view: FileView) {
  return view.refreshFromDisk()
}

// File views autosave after a short idle period.
export async function saveFile(view: FileView) {
  await view.save()
}

export function closeFile(view: FileView) {
  workViews.close(view.ref)
}

export function requestFileAtLocation(path: string) {
  return openFile(path, 42, 8)
}

export const fileViewPolicy = {
  deduplicateBy: "canonical-path",
  navigationState: "browser-local",
  contentState: "workspace-file",
  autosave: true,
}
`;

const context = `# Atelier

Atelier is a workspace interface for collaborating with coding agents while inspecting and operating on the work they produce.

## File view

A File view is a Resource Work view for reading and editing one workspace file. A canonical file path has at most one open File view inside a workspace.

## File navigator drawer

The File navigator drawer is a contextual overlay inside a File view. It keeps the file primary while exposing browsing and file actions.
`;

const files = new Map<FileId, PrototypeFile>([
  ["file", { id: "file", path: "apps/web/src/work-view.ts", initial: source, language: javascript({ typescript: true }), readOnly: new Compartment(), saved: source, disk: source, failNextSave: false }],
  ["file-context", { id: "file-context", path: "CONTEXT.md", initial: context, language: markdown(), readOnly: new Compartment(), saved: context, disk: context, failNextSave: false }],
]);

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: "#c586c0" },
  { tag: [tags.string, tags.regexp], color: "#ce9178" },
  { tag: [tags.comment, tags.meta], color: "#6a9955", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.heading], color: "#dcdcaa" },
  { tag: [tags.variableName, tags.propertyName], color: "#9cdcfe" },
  { tag: [tags.typeName, tags.className], color: "#4ec9b0" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "#1e1e1e", color: "#d4d4d4" },
  ".cm-scroller": { fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace', fontSize: "12px", lineHeight: "1.75", overflow: "auto" },
  ".cm-content": { minWidth: "max-content", padding: "16px 0 100px" },
  ".cm-gutters": { backgroundColor: "#1e1e1e", color: "#676767", border: "0", paddingLeft: "7px" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#ffffff08" },
  ".cm-cursor": { borderLeftColor: "#fff" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#285a8e88" },
  "&.cm-focused": { outline: "none" },
});

function status(file: PrototypeFile, label: string, state = "") {
  const element = document.querySelector<HTMLElement>(`[data-file-status="${file.id}"]`)!;
  element.textContent = label;
  element.className = `file-editor-status${state ? ` is-${state}` : ""}`;
}

function preview(file: PrototypeFile) {
  const output = document.querySelector<HTMLElement>(`[data-markdown-preview="${file.id}"]`)!;
  const raw = file.view!.state.doc.toString();
  output.innerHTML = raw
    .split("\n")
    .map((line) => {
      if (line.startsWith("## ")) return `<h2>${line.slice(3)}</h2>`;
      if (line.startsWith("# ")) return `<h1>${line.slice(2)}</h1>`;
      if (!line.trim()) return "";
      return `<p>${line}</p>`;
    })
    .join("");
}

function showRaw(file: PrototypeFile) {
  const host = document.querySelector<HTMLElement>(`[data-file-editor="${file.id}"]`)!;
  const output = document.querySelector<HTMLElement>(`[data-markdown-preview="${file.id}"]`);
  const toggle = document.querySelector<HTMLButtonElement>(`[data-file-action="toggle-preview"][data-file-id="${file.id}"]`);
  if (!output || !toggle) return;
  host.hidden = false;
  output.hidden = true;
  toggle.textContent = "Preview";
  toggle.setAttribute("aria-pressed", "false");
  file.view!.requestMeasure();
}

function setReadOnly(file: PrototypeFile, readOnly: boolean) {
  file.view!.dispatch({ effects: file.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  status(file, readOnly ? "Read only" : "Saved", readOnly ? "readonly" : "saved");
  const control = document.querySelector<HTMLButtonElement>(`[data-file-action="read-only"][data-file-id="${file.id}"]`)!;
  control.classList.toggle("active", readOnly);
  control.textContent = readOnly ? "Make writable" : "Read only";
}

function scheduleSave(file: PrototypeFile) {
  status(file, "Saving…", "saving");
  if (file.saveTimer) clearTimeout(file.saveTimer);
  file.saveTimer = setTimeout(() => {
    file.saveTimer = undefined;
    if (file.failNextSave) {
      file.failNextSave = false;
      status(file, "Couldn’t save", "error");
      return;
    }
    file.saved = file.view!.state.doc.toString();
    file.disk = file.saved;
    status(file, "Saved", "saved");
    if (file.id === "file-context") preview(file);
  }, 650);
}

function replaceDocument(file: PrototypeFile, content: string) {
  const view = file.view!;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  file.saved = content;
  file.disk = content;
}

function openConflict(file: PrototypeFile, external: string) {
  file.conflictDisk = external;
  status(file, "Conflict", "conflict");
  document.querySelector<HTMLDialogElement>(`[data-file-conflict="${file.id}"]`)!.showModal();
}

function jump(file: PrototypeFile, line: number, column: number) {
  showRaw(file);
  const target = file.view!.state.doc.line(Math.min(line, file.view!.state.doc.lines));
  const position = Math.min(target.to, target.from + Math.max(0, column - 1));
  file.view!.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
  file.view!.focus();
  document.querySelector<HTMLElement>(`[data-file-location="${file.id}"]`)!.textContent = `Ln ${target.number}, Col ${position - target.from + 1}`;
}

for (const file of files.values()) {
  const host = document.querySelector<HTMLElement>(`[data-file-editor="${file.id}"]`)!;
  file.view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: file.initial,
      extensions: [
        lineNumbers(), history(), drawSelection(), highlightActiveLine(), file.language,
        syntaxHighlighting(highlight), theme,
        file.readOnly.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) {
            const line = update.state.doc.lineAt(update.state.selection.main.head);
            document.querySelector<HTMLElement>(`[data-file-location="${file.id}"]`)!.textContent = `Ln ${line.number}, Col ${update.state.selection.main.head - line.from + 1}`;
          }
          if (update.docChanged) scheduleSave(file);
        }),
      ],
    }),
  });
}

new MutationObserver(() => {
  for (const file of files.values()) {
    if (!document.querySelector(`[data-view-panel="${file.id}"]`)?.hasAttribute("hidden")) file.view?.requestMeasure();
  }
}).observe(document.querySelector(".stage")!, { subtree: true, attributes: true, attributeFilter: ["hidden"] });

window.addEventListener("beforeunload", () => {
  for (const file of files.values()) file.view?.destroy();
});
