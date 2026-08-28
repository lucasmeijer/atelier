/// <reference lib="dom" />

import type { ReviewCommentModel } from "../model.ts";

interface ComposerCommentActions {
  navigate(comment: ReviewCommentModel): Promise<void>;
  delete(comment: ReviewCommentModel): Promise<void>;
}

function notifyComposer(resident: HTMLElement): void {
  resident.querySelector<HTMLTextAreaElement>('.fixed-shell-live-node[data-workspace-pane-role="agent"].is-active textarea[name="text"]')?.dispatchEvent(new Event("input", { bubbles: true }));
}

function commentPill(comment: ReviewCommentModel, resident: HTMLElement, actions: ComposerCommentActions): HTMLElement {
  const item = document.createElement("div");
  item.className = "review-comment-attachment";
  item.dataset.reviewCommentId = comment.id;

  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "reviewComment";
  input.value = comment.id;

  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "review-comment-attachment__primary";
  primary.title = `${comment.path}\n${comment.body}`;
  primary.textContent = comment.path.slice(comment.path.lastIndexOf("/") + 1);
  primary.addEventListener("click", () => { void actions.navigate(comment); });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "review-comment-attachment__remove";
  remove.title = `Delete review comment on ${comment.path}`;
  remove.setAttribute("aria-label", remove.title);
  remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  remove.addEventListener("click", () => {
    void actions.delete(comment).then(() => {
      item.remove();
      notifyComposer(resident);
    });
  });

  item.append(input, primary, remove);
  return item;
}

export function syncComposerReviewComments(resident: HTMLElement, comments: ReviewCommentModel[], actions: ComposerCommentActions): void {
  resident.querySelectorAll(".review-comment-attachment").forEach((item) => item.remove());
  const row = resident.querySelector<HTMLElement>('.fixed-shell-live-node[data-workspace-pane-role="agent"].is-active [data-agent-attachments-target="row"]')!;
  row.append(...comments.map((comment) => commentPill(comment, resident, actions)));
  notifyComposer(resident);
}
