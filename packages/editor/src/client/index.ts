/// <reference lib="dom" />

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/legacy-modes/mode/go";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { CableTopics, type WorkspaceClientControllerConstructor, type WorkspaceClientModule } from "@atelier/shared";

const editorHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--editor-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--editor-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--editor-number)" },
  { tag: [tags.comment, tags.meta], color: "var(--editor-comment)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.propertyName), tags.heading], color: "var(--editor-title)" },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: "var(--editor-variable)" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "var(--editor-type)" },
]);

function extensionOf(path: string): string {
  return path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
}

function languageExtension(path: string): Extension {
  const extension = extensionOf(path);
  if (["js", "mjs", "cjs", "jsx"].includes(extension)) return javascript({ jsx: extension === "jsx" });
  if (["ts", "mts", "cts", "tsx"].includes(extension)) return javascript({ typescript: true, jsx: extension === "tsx" });
  if (["json", "jsonc"].includes(extension)) return json();
  if (["html", "htm"].includes(extension)) return html();
  if (extension === "css") return css();
  if (["md", "markdown"].includes(extension)) return markdown();
  if (extension === "py") return python();
  if (extension === "rs") return rust();
  if (extension === "java") return java();
  if (["c", "h", "cc", "cpp", "cxx", "hpp"].includes(extension)) return cpp();
  if (extension === "rb") return StreamLanguage.define(ruby);
  if (extension === "go") return StreamLanguage.define(go);
  if (["sh", "bash", "zsh"].includes(extension)) return StreamLanguage.define(shell);
  return [];
}

type EditorFileResponse = { path: string; content: string; revision: string; writable: boolean };
type EditorRefreshDetail = { workspaceId: string; tabKey?: string; line?: number; column?: number };

function createFileEditorController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FileEditorController extends Controller {
    static values = { workspaceId: String, path: String, contentUrl: String, line: Number, column: Number };
    static targets = ["host", "status", "conflict", "preview", "previewToggle"];

    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly pathValue: string;
    declare readonly contentUrlValue: string;
    declare readonly lineValue: number;
    declare readonly columnValue: number;
    declare readonly hostTarget: HTMLElement;
    declare readonly statusTarget: HTMLElement;
    declare readonly conflictTarget: HTMLDialogElement;
    declare readonly previewTarget: HTMLElement;
    declare readonly previewToggleTarget: HTMLButtonElement;
    declare readonly hasPreviewTarget: boolean;

    private view?: EditorView;
    private previewSequence = 0;
    private revision = "";
    private savedContent = "";
    private latestDisk?: EditorFileResponse;
    private saveTimer?: ReturnType<typeof setTimeout>;
    private applyingDisk = false;
    private saveSequence = 0;

    connect(): void {
      window.addEventListener("atelier:file-editor-refresh", this.refreshRequested as EventListener);
      void this.load();
    }

    disconnect(): void {
      window.removeEventListener("atelier:file-editor-refresh", this.refreshRequested as EventListener);
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.view?.destroy();
    }

    async useMine(): Promise<void> {
      this.conflictTarget.close();
      await this.save(true);
    }

    async togglePreview(): Promise<void> {
      if (this.previewTarget.hidden) await this.showPreview();
      else this.showRaw();
    }

    useTheirs(): void {
      const latest = this.latestDisk!;
      this.conflictTarget.close();
      this.applyDisk(latest);
      this.setStatus("Updated", "");
      this.refreshVisiblePreview();
    }

    private async load(): Promise<void> {
      const file = await this.fetchFile();
      this.revision = file.revision;
      this.savedContent = file.content;
      this.view = new EditorView({
        parent: this.hostTarget,
        state: EditorState.create({
          doc: file.content,
          extensions: [
            history(),
            drawSelection(),
            highlightActiveLine(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            highlightSelectionMatches(),
            syntaxHighlighting(editorHighlightStyle),
            languageExtension(this.pathValue),
            EditorState.readOnly.of(!file.writable),
            EditorView.editable.of(file.writable),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged || this.applyingDisk) return;
              this.setStatus("Saving…", "saving");
              if (this.saveTimer) clearTimeout(this.saveTimer);
              this.saveTimer = setTimeout(() => void this.save(false), 500);
            }),
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
          ],
        }),
      });
      this.setStatus(file.writable ? "" : "Read only", "");
      this.jumpTo(this.lineValue, this.columnValue);
      if (this.hasPreviewTarget && this.lineValue < 1) await this.showPreview();
    }

    private readonly refreshRequested = (event: CustomEvent<EditorRefreshDetail>): void => {
      const detail = event.detail;
      if (detail.workspaceId !== this.workspaceIdValue) return;
      if (detail.tabKey && detail.tabKey !== this.element.dataset.tabPane) return;
      if (detail.line) this.jumpTo(detail.line, detail.column);
      void this.checkDisk();
    };

    private async checkDisk(): Promise<void> {
      if (!this.view) return;
      const latest = await this.fetchFile();
      if (latest.revision === this.revision) return;
      if (this.view.state.doc.toString() !== this.savedContent) {
        this.showConflict(latest);
        return;
      }
      this.applyDisk(latest);
      this.setStatus(latest.writable ? "Updated" : "Read only", "");
      this.refreshVisiblePreview();
    }

    private async save(force: boolean): Promise<void> {
      if (!this.view) return;
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      const content = this.view.state.doc.toString();
      if (!force && content === this.savedContent) {
        this.setStatus("", "");
        return;
      }
      const sequence = ++this.saveSequence;
      this.setStatus("Saving…", "saving");
      const response = await fetch(this.contentUrlValue, {
        method: "PUT",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ content, revision: this.revision, force }),
      });
      if (sequence !== this.saveSequence) return;
      if (response.status === 409) {
        this.showConflict(await response.json() as EditorFileResponse);
        return;
      }
      if (!response.ok) {
        this.setStatus(await response.text(), "error");
        return;
      }
      const result = await response.json() as { revision: string };
      this.revision = result.revision;
      this.savedContent = content;
      this.setStatus("Saved", "saved");
    }

    private async fetchFile(): Promise<EditorFileResponse> {
      const response = await fetch(this.contentUrlValue, { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error(await response.text());
      return await response.json() as EditorFileResponse;
    }

    private applyDisk(file: EditorFileResponse): void {
      const view = this.view!;
      this.applyingDisk = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } });
      this.applyingDisk = false;
      this.revision = file.revision;
      this.savedContent = file.content;
      this.latestDisk = undefined;
    }

    private showConflict(file: EditorFileResponse): void {
      this.latestDisk = file;
      this.setStatus("Conflict", "conflict");
      if (!this.conflictTarget.open) this.conflictTarget.showModal();
    }

    private async showPreview(): Promise<void> {
      const sequence = ++this.previewSequence;
      this.previewToggleTarget.disabled = true;
      const response = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/file-editor/markdown-preview`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8", "accept": "text/html" },
        body: this.view!.state.doc.toString(),
      });
      if (!response.ok) throw new Error(await response.text());
      const html = await response.text();
      if (sequence !== this.previewSequence) return;
      this.previewTarget.innerHTML = html;
      this.setPreviewVisible(true);
    }

    private showRaw(): void {
      if (!this.hasPreviewTarget) return;
      this.previewSequence++;
      this.setPreviewVisible(false);
    }

    private setPreviewVisible(visible: boolean): void {
      this.previewTarget.hidden = !visible;
      this.hostTarget.hidden = visible;
      this.previewToggleTarget.disabled = false;
      this.previewToggleTarget.textContent = visible ? "Raw" : "Preview";
      this.previewToggleTarget.setAttribute("aria-pressed", String(visible));
    }

    private refreshVisiblePreview(): void {
      if (this.hasPreviewTarget && !this.previewTarget.hidden) void this.showPreview();
    }

    private jumpTo(line: number, column = 1): void {
      if (!this.view || line < 1) return;
      this.showRaw();
      const targetLine = this.view.state.doc.line(Math.min(line, this.view.state.doc.lines));
      const position = Math.min(targetLine.to, targetLine.from + Math.max(0, column - 1));
      this.view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
      this.view.focus();
    }

    private setStatus(text: string, state: "" | "saving" | "saved" | "error" | "conflict"): void {
      this.statusTarget.textContent = text;
      this.statusTarget.className = `file-editor-status${state ? ` is-${state}` : ""}`;
    }
  };
}

function createFileEditorSignalController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FileEditorSignalController extends Controller {
    static values = { workspaceId: String, tabKey: String, line: Number, column: Number };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly tabKeyValue: string;
    declare readonly hasTabKeyValue: boolean;
    declare readonly lineValue: number;
    declare readonly columnValue: number;

    connect(): void {
      window.AtelierCable?.subscribe(CableTopics.workspace(this.workspaceIdValue));
      queueMicrotask(() => {
        if (this.hasTabKeyValue) {
          const resident = this.element.closest<HTMLElement>(`.workspace-detail-resident[data-workspace-id="${CSS.escape(this.workspaceIdValue)}"]`)!;
          resident.querySelector<HTMLButtonElement>(`.group-tab[data-tab="${CSS.escape(this.tabKeyValue)}"] .group-tab-label`)?.click();
        }
        window.dispatchEvent(new CustomEvent<EditorRefreshDetail>("atelier:file-editor-refresh", { detail: {
          workspaceId: this.workspaceIdValue,
          ...(this.hasTabKeyValue ? { tabKey: this.tabKeyValue, line: this.lineValue, column: this.columnValue } : {}),
        } }));
      });
    }

    disconnect(): void {
      window.AtelierCable?.unsubscribe(CableTopics.workspace(this.workspaceIdValue));
    }
  };
}

const editorClientModule: WorkspaceClientModule = {
  id: "editor",
  install({ application, Controller }) {
    application.register("file-editor", createFileEditorController(Controller));
    application.register("file-editor-signal", createFileEditorSignalController(Controller));
  },
};

export { editorClientModule as atelierClientModule };
