import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { atelierPierreTheme } from "./diff-options.ts";

registerCustomCSSVariableTheme(atelierPierreTheme, {
  foreground: "var(--text-bright)", background: "transparent",
  "token-comment": "var(--syntax-comment)", "token-string": "var(--syntax-string)",
  "token-string-expression": "var(--syntax-string)", "token-keyword": "var(--syntax-keyword)",
  "token-function": "var(--syntax-function)", "token-parameter": "var(--syntax-variable)",
  "token-constant": "var(--syntax-constant)", "token-punctuation": "var(--syntax-punctuation)",
  "token-link": "var(--syntax-attribute)",
}, false);

export { reviewDiffOptions, toolDiffOptions } from "./diff-options.ts";
