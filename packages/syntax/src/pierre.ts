import { registerCustomCSSVariableTheme } from "@pierre/diffs";

const atelierPierreTheme = "atelier";

registerCustomCSSVariableTheme(atelierPierreTheme, {
  foreground: "var(--text-bright)", background: "transparent",
  "token-comment": "var(--syntax-comment)", "token-string": "var(--syntax-string)",
  "token-string-expression": "var(--syntax-string)", "token-keyword": "var(--syntax-keyword)",
  "token-function": "var(--syntax-function)", "token-parameter": "var(--syntax-variable)",
  "token-constant": "var(--syntax-constant)", "token-punctuation": "var(--syntax-punctuation)",
  "token-link": "var(--syntax-attribute)",
}, false);

const changedLineCSS = `[data-line-type="change-addition"], [data-line-type="change-deletion"] { --mix-light: 80%; --mix-dark: 80%; }`;
const annotationCSS = `[data-line-annotation]:has(slot[name^="annotation-additions-"]) { --diffs-annotation-bg: var(--diffs-bg-addition); background: var(--diffs-bg-addition); } [data-line-annotation]:has(slot[name^="annotation-deletions-"]) { --diffs-annotation-bg: var(--diffs-bg-deletion); background: var(--diffs-bg-deletion); } [data-gutter-buffer="annotation"] { --diffs-annotation-bg: var(--diffs-bg-addition-number); background: var(--diffs-bg-addition-number); }`;

function diffOptions(presentation: "review" | "tool") {
  const review = presentation === "review";
  return {
    theme: atelierPierreTheme,
    themeType: "dark" as const,
    diffStyle: "unified" as const,
    overflow: "scroll" as const,
    disableLineNumbers: true,
    disableFileHeader: true,
    hunkSeparators: review ? "line-info" as const : "simple" as const,
    expansionLineCount: review ? 40 : 3,
    collapsedContextThreshold: review ? 6 : 0,
    lineDiffType: "word-alt" as const,
    stickyHeader: false,
    unsafeCSS: review ? `${changedLineCSS} ${annotationCSS}` : changedLineCSS,
  };
}

export const reviewDiffOptions = diffOptions("review");
export const toolDiffOptions = diffOptions("tool");
