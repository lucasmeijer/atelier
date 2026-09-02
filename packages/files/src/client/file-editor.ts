/// <reference lib="dom" />

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { setToggleValue, type ToggleChangeEvent } from "@atelier/design-system/toggle/client";
import { CableTopics, type WorkspaceClientApplication, type WorkspaceClientControllerConstructor } from "@atelier/shared";
import { parseEditableFileResponse, parseFileSaveResponse, type EditableFileResponse } from "../protocol.ts";
import { languageExtension } from "./editor-language.ts";

const editorHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--editor-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--editor-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--editor-number)" },
  { tag: [tags.comment, tags.meta], color: "var(--editor-comment)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.propertyName), tags.heading], color: "var(--editor-title)" },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: "var(--editor-variable)" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "var(--editor-type)" },
]);

type EditorRefreshDetail = { workspaceId: string };

function createFileEditorController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FileEditorController extends Controller {
    static values = { workspaceId: String, path: String, contentUrl: String, line: Number, column: Number };
    static targets = ["host", "loading", "status", "conflict", "preview", "previewOptions", "copyButton"];

    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly pathValue: string;
    declare readonly contentUrlValue: string;
    declare readonly lineValue: number;
    declare readonly columnValue: number;
    declare readonly hostTarget: HTMLElement;
    declare readonly loadingTarget: HTMLElement;
    declare readonly statusTarget: HTMLElement;
    declare readonly conflictTarget: HTMLDialogElement;
    declare readonly previewTarget: HTMLElement;
    declare readonly previewOptionsTarget: HTMLElement;
    declare readonly copyButtonTarget: HTMLButtonElement;
    declare readonly hasPreviewTarget: boolean;

    private view?: EditorView;
    private previewSequence = 0;
    private revision = "";
    private savedContent = "";
    private latestDisk?: EditableFileResponse;
    private saveTimer?: ReturnType<typeof setTimeout>;
    private applyingDisk = false;
    private saveSequence = 0;

    connect(): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      window.addEventListener("atelier:files-refresh", this.refreshRequested as EventListener);
      this.updateWorkViewLabel();
      void this.load().catch((error: Error) => this.showLoadError(error));
    }

    disconnect(): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      window.removeEventListener("atelier:files-refresh", this.refreshRequested as EventListener);
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.view?.destroy();
    }

    async useMine(): Promise<void> {
      this.conflictTarget.close();
      await this.save(true);
    }

    async selectPreviewMode(event: ToggleChangeEvent): Promise<void> {
      if (event.detail.value === "preview") {
        if (this.previewTarget.hidden) await this.showPreview();
      } else {
        this.showRaw();
      }
    }

    useTheirs(): void {
      const latest = this.latestDisk!;
      this.conflictTarget.close();
      this.applyDisk(latest);
      this.setStatus("Updated", "");
      this.refreshVisiblePreview();
    }

    private updateWorkViewLabel(): void {
      const liveNode = this.element.closest<HTMLElement>("[data-workspace-pane-id]")!;
      const presentation = liveNode.closest<HTMLElement>(".fixed-workspace-presentation")!;
      const selector = presentation.querySelector<HTMLElement>(`[data-work-view-reorder-key="${CSS.escape(liveNode.dataset.workspacePaneId!)}"]`)!;
      const label = this.pathValue.split("/").pop()!;
      selector.querySelector<HTMLElement>(".action-item__label-text")!.textContent = label;
      selector.querySelector<HTMLElement>("[data-atelier-fullscreen-title-value]")!.dataset.atelierFullscreenTitleValue = label;
    }

    private async load(): Promise<void> {
      const file = await this.fetchFile();
      this.revision = file.revision;
      this.savedContent = file.content;
      this.loadingTarget.remove();
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
              if (!update.docChanged) return;
              this.copyButtonTarget.dataset.copyText = update.state.doc.toString();
              if (this.applyingDisk) return;
              this.setStatus("Saving…", "saving");
              if (this.saveTimer) clearTimeout(this.saveTimer);
              this.saveTimer = setTimeout(() => void this.save(false), 500);
            }),
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
          ],
        }),
      });
      this.copyButtonTarget.dataset.copyText = file.content;
      this.copyButtonTarget.disabled = false;
      this.setStatus(file.writable ? "" : "Read only", "");
      this.jumpTo(this.lineValue, this.columnValue);
      if (this.hasPreviewTarget && this.lineValue < 1) await this.showPreview();
    }

    private readonly refreshRequested = (event: CustomEvent<EditorRefreshDetail>): void => {
      const detail = event.detail;
      if (detail.workspaceId !== this.workspaceIdValue) return;
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
        this.showConflict(parseEditableFileResponse(await response.json()));
        return;
      }
      if (!response.ok) {
        this.setStatus(await response.text(), "error");
        return;
      }
      const result = parseFileSaveResponse(await response.json());
      this.revision = result.revision;
      this.savedContent = content;
      this.setStatus("Saved", "saved");
    }

    private async fetchFile(): Promise<EditableFileResponse> {
      const response = await fetch(this.contentUrlValue, { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error(await response.text());
      return parseEditableFileResponse(await response.json());
    }

    private applyDisk(file: EditableFileResponse): void {
      const view = this.view!;
      this.applyingDisk = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } });
      this.applyingDisk = false;
      this.revision = file.revision;
      this.savedContent = file.content;
      this.latestDisk = undefined;
    }

    private showConflict(file: EditableFileResponse): void {
      this.latestDisk = file;
      this.setStatus("Conflict", "conflict");
      if (!this.conflictTarget.open) this.conflictTarget.showModal();
    }

    private async showPreview(): Promise<void> {
      const sequence = ++this.previewSequence;
      this.setPreviewBusy(true);
      try {
        const previewUrl = `/workspaces/${encodeURIComponent(this.workspaceIdValue)}/files-view/markdown-preview?${new URLSearchParams({ path: this.pathValue })}`;
        const response = await fetch(previewUrl, {
          method: "POST",
          headers: { "content-type": "text/plain; charset=utf-8", "accept": "text/html" },
          body: this.view!.state.doc.toString(),
        });
        if (sequence !== this.previewSequence) return;
        if (!response.ok) throw new Error(await response.text());
        const html = await response.text();
        if (sequence !== this.previewSequence) return;
        this.previewTarget.innerHTML = html;
        this.setPreviewVisible(true);
      } catch (error) {
        if (sequence !== this.previewSequence) return;
        this.setPreviewVisible(false);
        this.setStatus("Unable to render", "error");
        throw error;
      } finally {
        if (sequence === this.previewSequence) this.setPreviewBusy(false);
      }
    }

    private showRaw(): void {
      if (!this.hasPreviewTarget) return;
      this.previewSequence++;
      this.setPreviewBusy(false);
      this.setPreviewVisible(false);
    }

    private setPreviewBusy(busy: boolean): void {
      this.previewOptionsTarget.setAttribute("aria-busy", String(busy));
    }

    private setPreviewVisible(visible: boolean): void {
      this.previewTarget.hidden = !visible;
      this.hostTarget.hidden = visible;
      setToggleValue(this.previewOptionsTarget, visible ? "preview" : "edit");
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

    private showLoadError(error: Error): void {
      this.loadingTarget.textContent = error.message;
      this.loadingTarget.classList.add("is-error");
      this.setStatus("Unable to open", "error");
    }

    private setStatus(text: string, state: "" | "saving" | "saved" | "error" | "conflict"): void {
      this.statusTarget.textContent = text;
      this.statusTarget.className = `file-editor-status${state ? ` is-${state}` : ""}`;
    }
  };
}

function createFilesRefreshSignalController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FilesRefreshSignalController extends Controller {
    static values = { workspaceId: String };
    declare readonly workspaceIdValue: string;

    connect(): void {
      window.AtelierCable?.subscribe(CableTopics.workspace(this.workspaceIdValue));
      queueMicrotask(() => window.dispatchEvent(new CustomEvent<EditorRefreshDetail>("atelier:files-refresh", { detail: { workspaceId: this.workspaceIdValue } })));
    }

    disconnect(): void {
      window.AtelierCable?.unsubscribe(CableTopics.workspace(this.workspaceIdValue));
    }
  };
}

export function installFileEditorControllers(application: WorkspaceClientApplication, Controller: WorkspaceClientControllerConstructor): void {
  application.register("file-editor", createFileEditorController(Controller));
  application.register("files-refresh-signal", createFilesRefreshSignalController(Controller));
}
