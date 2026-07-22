import { describe, expect, test } from "bun:test";
import { embeddedBashCommandHtml } from "../../src/server/embedded-code.ts";

const renderEmbedded = (command: string): string => embeddedBashCommandHtml(command)!;

describe("embedded code literals", () => {
  test("bash heredoc writes preserve the shell while reformatting the nested file for display", () => {
    const compact = "import { chromium } from '@playwright/test';const browser=await chromium.launch();if(browser){console.log('ready');}";
    const command = `cat >/work/tmp-inspect.mjs <<'EOF'\n${compact}\nEOF\nnode /work/tmp-inspect.mjs; rm /work/tmp-inspect.mjs`;
    const html = renderEmbedded(command);
    expect(html).toContain("/work/tmp-inspect.mjs");
    expect(html).toContain("language-javascript");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("chromium");
    expect(html).toContain("data-atelier-display-formatted");
    expect(html).toContain('\n  <span class="hljs-variable language_">console</span>');
    expect(html).not.toContain(compact);
    expect(html).toContain("&gt;/work/tmp-inspect.mjs");
    expect(html).toContain("EOF");
    expect(html).toContain("node /work/tmp-inspect.mjs");
  });

  test("recognizes heredoc file writes sampled from historical agent sessions", () => {
    const samples = [
      { name: "no spaces around redirect", path: "/work/tmp-shot.mjs", command: "cat >/work/tmp-shot.mjs <<'EOF'\nconst x={a:1};\nEOF" },
      { name: "command prefix and relative path", path: "inspect.mjs", command: "cd /work && cat > inspect.mjs <<'EOF'\nconst x={a:1};\nEOF\nnode inspect.mjs" },
      { name: "commands before cat on the same line", path: "/work/tmp-check.mjs", command: "sleep 2; cat >/work/tmp-check.mjs <<'EOF'\nconst x={a:1};\nEOF" },
      { name: "custom quoted delimiter", path: "test.ts", language: "typescript", command: "cd /tmp/diffstest && cat > test.ts <<'TS'\nconst x={a:1};\nTS" },
      { name: "double-quoted path and delimiter", path: "/tmp/test.js", command: "cat > \"/tmp/test.js\" <<\"JS\"\nconst x={a:1};\nJS" },
      { name: "unquoted delimiter", path: "/tmp/test.js", command: "cat > /tmp/test.js <<JS\nconst x={a:1};\nJS" },
      { name: "append redirect", path: "/tmp/test.js", command: "cat >> /tmp/test.js <<'EOF'\nconst x={a:1};\nEOF" },
      { name: "tab-stripping heredoc", path: "/tmp/test.js", command: "cat > /tmp/test.js <<-'EOF'\n\tconst x={a:1};\n\tEOF" },
    ];
    for (const sample of samples) {
      const html = renderEmbedded(sample.command);
      expect(html, sample.name).toContain(sample.path);
      expect(html, sample.name).toContain("data-atelier-display-formatted");
      expect(html, sample.name).toContain(`language-${"language" in sample ? sample.language : "javascript"}`);
    }
  });

  test("formats and highlights a Python heredoc", () => {
    const compact = "def greet(name):\n  if name: print('hello',name)";
    const html = renderEmbedded(`cat > /tmp/analyze.py <<'PY'\n${compact}\nPY`);
    expect(html).toContain('class="language-python" data-atelier-display-formatted');
    expect(html).toContain("hljs-keyword");
    expect(html).toContain('\n    <span class="hljs-keyword">if</span>');
    expect(html).not.toContain(compact);
  });

  test("formats and highlights a JSON heredoc without another formatter dependency", () => {
    const compact = '{"name":"Atelier","languages":["js","ts","py"]}';
    const html = renderEmbedded(`cat > /tmp/demo.json <<'JSON'\n${compact}\nJSON`);
    expect(html).toContain('class="language-json" data-atelier-display-formatted');
    expect(html).toContain('&quot;languages&quot;</span><span class="hljs-punctuation">:</span> <span class="hljs-punctuation">[</span>');
    expect(html).not.toContain(compact);
  });

  test("does not recognize cat heredoc text inside a quoted shell argument", () => {
    const command = `printf '%s\\n' "cat > /tmp/not-written.js <<'EOF'" "const x={a:1};" "EOF"`;
    expect(embeddedBashCommandHtml(command)).toBeUndefined();
  });

  test("formats multiple heredoc writes in one bash call", () => {
    const command = "mkdir -p /tmp/demo; cat > /tmp/one.js <<'JS'\nconst one={n:1};\nJS\ncat > /tmp/two.ts <<'TS'\nconst two={n:2};\nTS\nnode /tmp/one.js";
    const html = renderEmbedded(command);
    expect(html.match(/data-atelier-display-formatted/g)).toHaveLength(2);
    expect(html).toContain("language-javascript");
    expect(html).toContain("language-typescript");
    expect(html).toContain("node /tmp/one.js");
  });

  test("highlights source passed directly to interpreters through stdin", () => {
    const samples = [
      { name: "bun JavaScript", command: "bun - <<'JS'\nconst answer={value:42};\nJS", language: "javascript" },
      { name: "bun TypeScript after cd", command: "cd /work && bun - <<'TS'\nconst answer:number=42;\nTS", language: "typescript" },
      { name: "bun behind timeout", command: "cd /work && timeout 20 bun - <<'TS'\nconst answer:number=42;\nTS", language: "typescript" },
      { name: "node with arguments", command: "node --input-type=module - <<'NODE'\nconst answer={value:42};\nNODE", language: "javascript" },
      { name: "Python", command: "python3 - <<'PY'\nanswer={'value':42}\nPY", language: "python" },
      { name: "Python in a shell function", command: "now_ms(){ python3 - <<'PY'\nprint(42)\nPY\n}", language: "python" },
      { name: "Python after then", command: "if true; then python3 - 'argument' <<'PY'\nprint(42)\nPY\nfi", language: "python" },
    ];
    for (const sample of samples) {
      const html = renderEmbedded(sample.command);
      expect(html, sample.name).toContain(`class="language-${sample.language}"`);
      expect(html, sample.name).toContain("hljs-");
    }
  });

  test("does not treat interpreter heredocs nested inside a written shell script as outer commands", () => {
    const command = "cat > /tmp/run.sh <<'SH'\npython3 - <<'PY'\nprint(42)\nPY\nSH";
    const html = renderEmbedded(command);
    expect(html).toContain('<span class="language-bash">');
    expect(html).not.toContain('class="language-python"');
  });

  test("returns no override for unknown stdin heredocs", () => {
    expect(embeddedBashCommandHtml("sed 's/a/b/' <<'EOF'\na\nEOF")).toBeUndefined();
  });
});
