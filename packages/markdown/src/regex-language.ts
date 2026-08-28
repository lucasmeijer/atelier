import type { LanguageFn } from "highlight.js";

export const regexLanguage: LanguageFn = () => ({
  name: "Regular Expression",
  contains: [
    { scope: "comment", begin: /\(\?#/, end: /\)/ },
    { scope: "built_in", begin: /\[(?:\\.|[^\]\\])*\]/ },
    { scope: "built_in", begin: /\\(?:[pP]\{[^}]*\}|k<[^>]*>|[xu]\{[^}]*\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|c.|.)/ },
    { begin: [/\(\?</, /[A-Za-z_]\w*/, />/], beginScope: { 1: "title", 2: "variable", 3: "title" } },
    { scope: "title", begin: /\(\?(?:<=|<!|[:=!>]|[A-Za-z-]+(?::|\)))|[()]/ },
    { scope: "regex-alternation", begin: /\|/ },
    { scope: "keyword", begin: /(?:\{\d+(?:,\d*)?\}|[*+?])[?+]?|[\^$]/ },
  ],
});
