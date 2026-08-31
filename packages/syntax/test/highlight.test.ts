import { describe, expect, test } from "bun:test";
import palettes from "./fixtures/palettes.json";
import { highlightCodeHtml, languageFromPath } from "../src/index.ts";

describe("Atelier syntax highlighting", () => {
  test("resolves paths and emits theme roles", () => {
    expect(languageFromPath("src/view.tsx")).toBe("tsx");
    const result = highlightCodeHtml({ code: "const answer: number = 42; // meaning", path: "view.ts" });
    expect(result.language).toBe("typescript");
    expect(result.html).toContain("syntax-keyword");
    expect(highlightCodeHtml({ code: "// meaning", language: "typescript" }).html).toContain("syntax-comment");
  });
  test("highlights Ruby embedded in HTML templates", () => {
    expect(languageFromPath("app/views/users/show.html.erb")).toBe("erb");
    expect(languageFromPath("app/views/users/show.rhtml")).toBe("erb");
    const result = highlightCodeHtml({
      code: "<% if user.admin? %><strong><%= user.name %></strong><% end %>",
      language: "erb",
    });
    expect(result.language).toBe("erb");
    expect(result.html).toContain("syntax-keyword");
    expect(result.html).toContain("syntax-tag");
  });

  test("supports common configuration and web languages", () => {
    const paths = {
      "config.yml": "yaml",
      "query.sql": "sql",
      Dockerfile: "docker",
      "theme.scss": "scss",
      "component.vue": "vue",
      "component.svelte": "svelte",
      "page.astro": "astro",
      "component.tsx": "tsx",
      "component.jsx": "jsx",
      "main.tf": "terraform",
      "variables.hcl": "hcl",
      "index.php": "php",
    } as const;

    for (const [filePath, language] of Object.entries(paths)) {
      expect(languageFromPath(filePath), filePath).toBe(language);
    }

    const samples = {
      yaml: "enabled: true",
      sql: "SELECT id FROM users;",
      dockerfile: "FROM ubuntu:latest",
      scss: "$gap: 1rem; .card { padding: $gap; }",
      vue: "<template><button>{{ label }}</button></template>",
      svelte: "<script>let count = 0;</script><button>{count}</button>",
      astro: "---\nconst title = 'Hello';\n---\n<h1>{title}</h1>",
      tsx: "const View = () => <main>Hello</main>;",
      jsx: "const View = () => <main>Hello</main>;",
      tf: "resource \"aws_s3_bucket\" \"assets\" {}",
      hcl: "service { port = 3000 }",
      php: "<?php echo 'Hello'; ?>",
    } as const;

    for (const [language, code] of Object.entries(samples)) {
      const result = highlightCodeHtml({ code, language });
      expect(result.language, language).toBe(language === "dockerfile" ? "docker" : language === "tf" ? "terraform" : language);
      expect(result.html, language).toContain("class=\"syntax-");
    }
  });

  test("safely escapes unsupported and incomplete input", () => {
    expect(highlightCodeHtml({ code: '<script>&', language: "unknown" })).toEqual({ html: "&lt;script&gt;&amp;" });
    expect(() => highlightCodeHtml({ code: 'const value = "', language: "ts" })).not.toThrow();
  });

  test("keeps the five captured palettes distinct", () => {
    expect(Object.keys(palettes)).toEqual(["daylight", "cappuccino", "tokyo-night", "midnight", "nord"]);
    expect(new Set(Object.values(palettes).map((palette) => palette.keyword)).size).toBe(5);
    expect(new Set(Object.values(palettes).map((palette) => palette.string)).size).toBe(5);
  });
});
