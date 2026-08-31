/// <reference lib="dom" />

import type { DiffLineAnnotation, FileDiff, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { Icons } from "@atelier/design-system/icons";
import { isWorkspacePaneVisible, type WorkspaceClientModule } from "@atelier/shared";
import { reviewCommentsPrompt, type ReviewCommentModel } from "../model.ts";
import { reviewDiffOptions } from "../pierre.ts";

type StimulusControllerConstructor = new (...args: never[]) => { element: Element };

type DraftModel = {
  kind: "draft";
  commentId?: string;
  path: string;
  side: ReviewCommentModel["side"];
  startLine: number;
  endLine: number;
  body: string;
};
type AnnotationMetadata = ({ kind: "comment" } & ReviewCommentModel) | DraftModel;
type DiffModel = { fileDiff: FileDiffMetadata; comments: ReviewCommentModel[] };
interface SavedReviewPosition { path: string; offset: number; line?: number; lineType?: string }
type FileDiffConstructor = typeof import("@pierre/diffs")["FileDiff"];

declare global {
  interface Window { Turbo?: { renderStreamMessage(html: string): void } }
}

function annotation(comment: ReviewCommentModel): DiffLineAnnotation<AnnotationMetadata> {
  return { side: comment.side, lineNumber: comment.startLine, metadata: { kind: "comment", ...comment } };
}

function selectedDiffLine(node: Node): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-content] > [data-line]") ?? undefined;
}

function sideForLine(line: HTMLElement): ReviewCommentModel["side"] {
  return line.dataset.lineType === "change-deletion" ? "deletions" : "additions";
}

function textButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button secondary";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function closeButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button secondary icon-only review-comment-close";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = Icons.Close;
  button.addEventListener("click", action);
  return button;
}

function fitTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function createReviewController(Controller: StimulusControllerConstructor) {
  return class ReviewController extends Controller {
    static values = { workspaceId: String };
    static targets = ["file", "diff"];
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly fileTargets: HTMLDetailsElement[];
    declare readonly diffTargets: HTMLElement[];
    private instances: FileDiff<AnnotationMetadata>[] = [];
    private containers = new Map<FileDiff<AnnotationMetadata>, HTMLElement>();
    private models = new Map<string, DiffModel>();
    private hydratedHosts = new WeakSet<HTMLElement>();
    private draft?: DraftModel;
    private hydrated = false;
    private wordDiffEnabled = false;
    private lineWrappingEnabled = true;
    private pane!: HTMLElement;
    private resident!: HTMLElement;
    private readonly becameVisible = (): void => { void this.becomeVisible(); };

    connect(): void {
      this.restoreDraft();
      this.pane = this.element.closest<HTMLElement>('[data-workspace-pane-role="work"]')!;
      this.resident = this.element.closest<HTMLElement>(".workspace-detail-resident")!;
      this.pane.addEventListener("atelier:workspace-pane-visible", this.becameVisible);
      if (isWorkspacePaneVisible(this.element)) void this.becomeVisible();
    }

    disconnect(): void {
      this.pane.removeEventListener("atelier:workspace-pane-visible", this.becameVisible);
      for (const instance of this.instances) instance.cleanUp();
      this.instances = [];
      this.containers.clear();
      this.models.clear();
      this.hydrated = false;
    }

    async becomeVisible(): Promise<void> {
      if (this.hydrated) return;
      this.hydrated = true;
      await Promise.all(this.diffTargets.map((host) => this.hydrateHost(host)));
      if (this.draft && !this.fileTargets.some((file) => file.dataset.reviewPath === this.draft?.path)) this.clearDraft();
      requestAnimationFrame(() => this.restorePosition());
    }

    diffTargetConnected(host: HTMLElement): void {
      if (this.hydrated) void this.hydrateHost(host);
    }

    requestFile(event: Event): void {
      if (!(event.currentTarget instanceof HTMLDetailsElement)) throw new Error("Review file loading requires details");
      if (event.type === "toggle" && !event.currentTarget.open) return;
      const frame = event.currentTarget.querySelector<HTMLElement>(":scope > turbo-frame[data-src]")!;
      if (!frame.hasAttribute("src")) frame.setAttribute("src", frame.dataset.src!);
    }

    collapseAll(): void {
      for (const file of this.fileTargets) file.open = false;
    }

    expandAll(): void {
      for (const file of this.fileTargets) file.open = true;
    }

    toggleWordDiff(event: Event): void {
      if (!(event.currentTarget instanceof HTMLButtonElement)) throw new Error("Word diff toggle requires a button");
      this.wordDiffEnabled = !this.wordDiffEnabled;
      event.currentTarget.setAttribute("aria-pressed", String(this.wordDiffEnabled));
      for (const instance of this.instances) {
        instance.setOptions({ ...instance.options, lineDiffType: this.wordDiffEnabled ? "word-alt" : reviewDiffOptions.lineDiffType });
        instance.rerender();
      }
    }

    toggleLineWrapping(event: Event): void {
      if (!(event.currentTarget instanceof HTMLButtonElement)) throw new Error("Line wrapping toggle requires a button");
      this.lineWrappingEnabled = !this.lineWrappingEnabled;
      event.currentTarget.setAttribute("aria-pressed", String(this.lineWrappingEnabled));
      for (const instance of this.instances) {
        instance.setOptions({ ...instance.options, overflow: this.lineWrappingEnabled ? "wrap" : "scroll" });
        instance.rerender();
      }
    }

    private async hydrateHost(host: HTMLElement): Promise<void> {
      if (this.hydratedHosts.has(host)) return;
      const { FileDiff } = await import("@pierre/diffs");
      if (!host.isConnected || this.hydratedHosts.has(host)) return;
      this.hydratedHosts.add(host);
      this.hydrateDiff(host, FileDiff);
    }

    private hydrateDiff(host: HTMLElement, FileDiffClass: FileDiffConstructor): void {
      const script = host.querySelector<HTMLScriptElement>("script[data-review-model]")!;
      // SAFETY: The server emits this private JSON script from a DiffModel and no external input can write it.
      const model = JSON.parse(script.textContent ?? "") as DiffModel;
      const path = host.dataset.reviewPath!;
      this.models.set(path, model);
      const container = host.querySelector<HTMLElement>("diffs-container")!;
      const shadowTemplate = container.querySelector<HTMLTemplateElement>(":scope > template[shadowrootmode]");
      const prerenderedHTML = shadowTemplate?.innerHTML;
      shadowTemplate?.remove();
      let instance: FileDiff<AnnotationMetadata>;
      instance = new FileDiffClass<AnnotationMetadata>({
        ...reviewDiffOptions,
        lineDiffType: this.wordDiffEnabled ? "word-alt" : reviewDiffOptions.lineDiffType,
        overflow: this.lineWrappingEnabled ? "wrap" : "scroll",
        renderAnnotation: (item) => this.renderAnnotation(item.metadata!, instance),
        onPostRender: () => this.decorateExpansionControls(container),
      });
      this.containers.set(instance, container);
      const draft = this.draft?.path === path ? this.draft : undefined;
      const lineAnnotations = this.annotations(path);
      instance.hydrate({ fileContainer: container, fileDiff: model.fileDiff, lineAnnotations, prerenderedHTML });
      if (draft) instance.render({ fileDiff: model.fileDiff, lineAnnotations: [...lineAnnotations] });
      this.instances.push(instance);
      this.enableTextCommenting(container, path, instance);
      this.decorateExpansionControls(container);
    }

    private annotations(path: string): DiffLineAnnotation<AnnotationMetadata>[] {
      const annotations = this.models.get(path)!.comments.filter((comment) => comment.id !== this.draft?.commentId).map(annotation);
      if (this.draft?.path === path) annotations.push({ side: this.draft.side, lineNumber: this.draft.startLine, metadata: this.draft });
      return annotations;
    }

    private decorateExpansionControls(container: HTMLElement): void {
      const root = container.shadowRoot;
      if (!root) return;
      if (!root.querySelector("style[data-review-anchor-style]")) {
        const style = document.createElement("style");
        style.dataset.reviewAnchorStyle = "";
        style.textContent = `[data-line][data-review-anchor] {
          box-shadow: inset 3px 0 var(--accent), inset 0 0 0 999px color-mix(in srgb, var(--accent) 13%, transparent);
          transition: box-shadow 160ms ease;
        }`;
        root.append(style);
      }
      const path = container.closest<HTMLElement>("[data-review-path]")!.dataset.reviewPath!;
      if (this.draft?.path === path) this.highlightAnchor(container, this.draft);
      root.querySelectorAll<HTMLElement>("[data-expand-button]:not([data-expand-all-button])").forEach((control) => {
        const direction = control.hasAttribute("data-expand-up") ? "above" : control.hasAttribute("data-expand-down") ? "below" : "around this change";
        const label = `Show 40 more lines ${direction}`;
        control.setAttribute("aria-label", label);
        control.title = label;
        this.makeKeyboardClickable(control);
      });
      root.querySelectorAll<HTMLElement>("[data-separator-content]").forEach((control) => {
        const omitted = control.querySelector<HTMLElement>("[data-unmodified-lines]")?.textContent;
        if (!omitted) return;
        control.setAttribute("role", "button");
        control.setAttribute("aria-label", `Show all ${omitted}`);
        control.title = `Show all ${omitted}`;
        this.makeKeyboardClickable(control);
      });
    }

    private makeKeyboardClickable(control: HTMLElement): void {
      control.tabIndex = 0;
      if (control.dataset.reviewKeyboard === "true") return;
      control.dataset.reviewKeyboard = "true";
      control.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        control.click();
      });
    }

    private highlightAnchor(container: HTMLElement, comment?: Pick<ReviewCommentModel, "side" | "startLine" | "endLine">): void {
      const root = container.shadowRoot!;
      root.querySelectorAll<HTMLElement>("[data-review-anchor]").forEach((line) => line.removeAttribute("data-review-anchor"));
      if (!comment) return;
      root.querySelectorAll<HTMLElement>("[data-content] > [data-line]").forEach((line) => {
        const number = Number(line.dataset.line);
        if (number < comment.startLine || number > comment.endLine || sideForLine(line) !== comment.side) return;
        line.dataset.reviewAnchor = "";
      });
    }

    private enableTextCommenting(container: HTMLElement, path: string, instance: FileDiff<AnnotationMetadata>): void {
      const root = container.shadowRoot!;
      root.addEventListener("pointerup", () => {
        // SAFETY: Chromium's ShadowRoot implements getSelection even though this DOM library omits it.
        const selection = (root as ShadowRoot & { getSelection(): Selection | null }).getSelection();
        if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
        const range = selection.getRangeAt(0);
        const start = selectedDiffLine(range.startContainer);
        const end = selectedDiffLine(range.endContainer);
        if (!start || !end) return;
        this.beginComment(path, { start: Number(start.dataset.line), end: Number(end.dataset.line), side: sideForLine(start), endSide: sideForLine(end) }, instance);
        selection.removeAllRanges();
      });
    }

    private beginComment(path: string, range: SelectedLineRange, instance: FileDiff<AnnotationMetadata>): void {
      if (this.draft) return;
      const side = range.side ?? "additions";
      const endLine = range.endSide && range.endSide !== side ? range.start : range.end;
      const draft: DraftModel = {
        kind: "draft",
        path,
        side,
        startLine: Math.min(range.start, endLine),
        endLine: Math.max(range.start, endLine),
        body: "",
      };
      this.draft = draft;
      this.persistDraft();
      const model = this.models.get(path)!;
      instance.render({ fileDiff: model.fileDiff, lineAnnotations: this.annotations(path) });
    }

    private renderAnnotation(metadata: AnnotationMetadata, instance: FileDiff<AnnotationMetadata>): HTMLElement {
      if (metadata.kind === "draft") return this.renderEditor(metadata, instance);
      const card = document.createElement("article");
      card.className = "review-inline-comment";
      card.dataset.reviewCommentId = metadata.id;
      const container = this.containers.get(instance)!;
      const showAnchor = (): void => this.highlightAnchor(container, metadata);
      const hideAnchor = (): void => this.highlightAnchor(container, this.draft?.path === metadata.path ? this.draft : undefined);
      card.addEventListener("pointerenter", showAnchor);
      card.addEventListener("pointerleave", hideAnchor);
      card.addEventListener("focusin", showAnchor);
      card.addEventListener("focusout", (event) => {
        if (!(event.relatedTarget instanceof Node) || !card.contains(event.relatedTarget)) hideAnchor();
      });
      card.append(closeButton("Delete review comment", () => void this.deleteComment(metadata.id)));
      const body = document.createElement("button");
      body.type = "button";
      body.className = "review-comment-content";
      body.setAttribute("aria-label", "Edit review comment");
      body.addEventListener("click", () => this.editComment(metadata, instance));
      const copy = document.createElement("p");
      copy.textContent = metadata.body;
      body.append(copy);
      card.append(body);
      return card;
    }

    private editComment(comment: ReviewCommentModel, instance: FileDiff<AnnotationMetadata>): void {
      if (this.draft) return;
      this.draft = { kind: "draft", commentId: comment.id, path: comment.path, side: comment.side, startLine: comment.startLine, endLine: comment.endLine, body: comment.body };
      this.persistDraft();
      const model = this.models.get(comment.path)!;
      instance.render({ fileDiff: model.fileDiff, lineAnnotations: this.annotations(comment.path) });
    }

    private renderEditor(draft: DraftModel, instance: FileDiff<AnnotationMetadata>): HTMLElement {
      const editor = document.createElement("div");
      editor.className = "review-comment-editor";
      editor.role = "dialog";
      editor.setAttribute("aria-label", "Review comment");
      editor.append(closeButton("Cancel review comment", () => this.cancelDraft(draft.path, instance)));
      const body = document.createElement("div");
      body.className = "review-comment-content";
      const textarea = document.createElement("textarea");
      textarea.className = "textarea";
      textarea.rows = 1;
      textarea.placeholder = "Leave a review comment";
      textarea.setAttribute("aria-label", "Review comment");
      textarea.setAttribute("aria-keyshortcuts", "Meta+Enter");
      textarea.value = draft.body;
      textarea.addEventListener("input", () => {
        draft.body = textarea.value;
        fitTextarea(textarea);
        this.persistDraft();
      });
      textarea.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || !event.metaKey) return;
        event.preventDefault();
        void this.saveDraft(draft, textarea);
      });
      const actions = document.createElement("footer");
      actions.className = "review-comment-actions";
      const save = textButton("Comment", () => void this.saveDraft(draft, textarea));
      save.className = "button primary";
      actions.append(save);
      body.append(textarea);
      editor.append(body, actions);
      requestAnimationFrame(() => {
        fitTextarea(textarea);
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      });
      return editor;
    }

    private cancelDraft(path: string, instance: FileDiff<AnnotationMetadata>): void {
      this.clearDraft();
      const model = this.models.get(path)!;
      instance.render({ fileDiff: model.fileDiff, lineAnnotations: this.annotations(path) });
    }

    private async saveDraft(draft: DraftModel, textarea: HTMLTextAreaElement): Promise<void> {
      const body = textarea.value.trim();
      if (!body) {
        textarea.focus();
        return;
      }
      const data = new FormData();
      data.set("path", draft.path);
      data.set("side", draft.side);
      data.set("startLine", String(draft.startLine));
      data.set("endLine", String(draft.endLine));
      data.set("body", body);
      this.rememberPosition();
      const endpoint = draft.commentId
        ? `/workspaces/${encodeURIComponent(this.workspaceIdValue)}/review/comments/${encodeURIComponent(draft.commentId)}/update`
        : `/workspaces/${encodeURIComponent(this.workspaceIdValue)}/review/comments`;
      const response = await fetch(endpoint, { method: "POST", body: data, headers: { Accept: "text/vnd.turbo-stream.html" } });
      if (!response.ok) throw new Error(await response.text());
      this.clearDraft();
      window.Turbo?.renderStreamMessage(await response.text());
    }

    private async deleteComment(id: string): Promise<void> {
      this.rememberPosition();
      const response = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/review/comments/${encodeURIComponent(id)}/delete`, { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" } });
      if (!response.ok) throw new Error(await response.text());
      window.Turbo?.renderStreamMessage(await response.text());
    }

    copyCommentsToComposer(): void {
      const input = this.resident.querySelector<HTMLTextAreaElement>('.fixed-shell-surface[data-workspace-pane-role="agent"].is-active textarea[name="text"]')!;
      const prompt = reviewCommentsPrompt(this.comments);
      const separator = input.value.length === 0 || input.value.endsWith("\n\n") ? "" : input.value.endsWith("\n") ? "\n" : "\n\n";
      input.value += `${separator}${prompt}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    private get comments(): ReviewCommentModel[] {
      const script = this.element.querySelector<HTMLScriptElement>("script[data-review-comments]")!;
      // SAFETY: The server emits this private JSON script from ReviewCommentModel values.
      return JSON.parse(script.textContent ?? "") as ReviewCommentModel[];
    }

    updateRefreshState(event: Event): void {
      if (!(event.currentTarget instanceof HTMLFormElement)) throw new Error("Review refresh requires a form");
      const button = event.currentTarget.querySelector<HTMLButtonElement>(".activity-button")!;
      const active = event.type === "submit";
      if (active) this.rememberPosition();
      button.dataset.activityState = active ? "active" : "initial";
      if (active) button.setAttribute("aria-busy", "true");
      else button.removeAttribute("aria-busy");
    }

    rememberPosition(): void {
      const scroller = this.element;
      const scrollerTop = scroller.getBoundingClientRect().top;
      const toolbarBottom = scrollerTop + (this.element.querySelector<HTMLElement>(".review-toolbar")?.offsetHeight ?? 0) + 12;
      const file = this.fileTargets.findLast((candidate) => candidate.getBoundingClientRect().top <= toolbarBottom) ?? this.fileTargets[0];
      if (file) {
        const saved: SavedReviewPosition = { path: file.dataset.reviewPath!, offset: file.getBoundingClientRect().top - scrollerTop };
        const container = file.querySelector<HTMLElement>("diffs-container");
        const numbers = [...(container?.shadowRoot?.querySelectorAll<HTMLElement>("[data-column-number]") ?? [])];
        const line = numbers.findLast((candidate) => candidate.getBoundingClientRect().top <= toolbarBottom);
        if (line) {
          saved.offset = line.getBoundingClientRect().top - scrollerTop;
          saved.line = Number(line.dataset.columnNumber);
          saved.lineType = line.dataset.lineType;
        }
        sessionStorage.setItem(this.positionKey, JSON.stringify(saved));
      }

    }

    private restorePosition(): void {
      const raw = sessionStorage.getItem(this.positionKey);
      sessionStorage.removeItem(this.positionKey);
      if (!raw) return;
      // SAFETY: rememberPosition writes this browser-owned value with this exact shape.
      const saved = JSON.parse(raw) as SavedReviewPosition;
      const file = this.fileTargets.find((candidate) => candidate.dataset.reviewPath === saved.path);
      if (!file) return;
      const scroller = this.element;
      let anchor: HTMLElement = file;
      if (saved.line !== undefined) {
        const root = file.querySelector<HTMLElement>("diffs-container")?.shadowRoot;
        const candidates = [...(root?.querySelectorAll<HTMLElement>(`[data-column-number="${saved.line}"]`) ?? [])];
        anchor = candidates.find((candidate) => candidate.dataset.lineType === saved.lineType) ?? candidates[0] ?? file;
      }
      scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset;
    }

    private persistDraft(): void {
      sessionStorage.setItem(this.draftKey, JSON.stringify(this.draft));
    }

    private clearDraft(): void {
      this.draft = undefined;
      sessionStorage.removeItem(this.draftKey);
    }

    private restoreDraft(): void {
      const raw = sessionStorage.getItem(this.draftKey);
      if (!raw) return;
      // SAFETY: persistDraft writes this session-owned value from a DraftModel.
      this.draft = JSON.parse(raw) as DraftModel;
    }

    private get positionKey(): string { return `atelier.review.position:${this.workspaceIdValue}`; }
    private get draftKey(): string { return `atelier.review.draft:${this.workspaceIdValue}`; }
  };
}

export const reviewClientModule: WorkspaceClientModule = {
  id: "review",
  install({ application, Controller }) {
    application.register("review", createReviewController(Controller));
  },
};

export { reviewClientModule as atelierClientModule };
