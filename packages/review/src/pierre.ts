export const reviewViewKey = "review:workspace";

export const reviewDiffOptions = {
  diffStyle: "unified" as const,
  overflow: "scroll" as const,
  disableFileHeader: true,
  hunkSeparators: "line-info" as const,
  expansionLineCount: 40,
  collapsedContextThreshold: 6,
  lineDiffType: "word-alt" as const,
  stickyHeader: false,
  unsafeCSS: `[data-line-annotation]:has(slot[name^="annotation-additions-"]) { --diffs-annotation-bg: var(--diffs-bg-addition); background: var(--diffs-bg-addition); } [data-line-annotation]:has(slot[name^="annotation-deletions-"]) { --diffs-annotation-bg: var(--diffs-bg-deletion); background: var(--diffs-bg-deletion); } [data-gutter-buffer="annotation"] { --diffs-annotation-bg: var(--diffs-bg-addition-number); background: var(--diffs-bg-addition-number); }`,
};
