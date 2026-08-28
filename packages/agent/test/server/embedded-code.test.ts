import { describe, expect, test } from "bun:test";
import { embeddedBashCommand, formatBashCommandForDisplay } from "../../src/server/embedded-code.ts";

const renderEmbedded = (command: string): string => embeddedBashCommand(command)!.html;
const renderedText = (html: string): string => html.replace(/<[^>]+>/g, "").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");

describe("embedded code literals", () => {
  test("bash heredoc writes preserve the shell while reformatting the nested file for display", () => {
    const compact = "import { chromium } from '@playwright/test';const browser=await chromium.launch();if(browser){console.log('ready');}";
    const command = `cat >/work/tmp-inspect.mjs <<'EOF'\n${compact}\nEOF\nnode /work/tmp-inspect.mjs; rm /work/tmp-inspect.mjs`;
    const html = renderEmbedded(command);
    expect(html).toContain("/work/tmp-inspect.mjs");
    expect(html).toContain("language-javascript");
    expect(html).toContain("syntax-keyword");
    expect(html).toContain("chromium");
    expect(renderedText(html)).toContain("\n  console");
    expect(html).not.toContain(compact);
    expect(renderedText(html)).toContain(">/work/tmp-inspect.mjs");
    expect(html).toContain("EOF");
    expect(renderedText(html)).toContain("node /work/tmp-inspect.mjs");
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
      expect(html, sample.name).not.toContain("x={a:1}");
      expect(html, sample.name).toContain(`language-${"language" in sample ? sample.language : "javascript"}`);
    }
  });

  test("formats and highlights a Python heredoc", () => {
    const compact = "def greet(name):\n  if name: print('hello',name)";
    const html = renderEmbedded(`cat > /tmp/analyze.py <<'PY'\n${compact}\nPY`);
    expect(html).toContain('class="language-python"');
    expect(html).toContain("syntax-keyword");
    expect(renderedText(html)).toContain("\n    if");
    expect(html).not.toContain(compact);
  });

  test("formats and highlights a JSON heredoc without another formatter dependency", () => {
    const compact = '{"name":"Atelier","languages":["js","ts","py"]}';
    const html = renderEmbedded(`cat > /tmp/demo.json <<'JSON'\n${compact}\nJSON`);
    expect(html).toContain('class="language-json"');
    expect(renderedText(html)).toContain('"languages": [');
    expect(html).not.toContain(compact);
  });

  test("does not recognize cat heredoc text inside a quoted shell argument", () => {
    const command = `printf '%s\\n' "cat > /tmp/not-written.js <<'EOF'" "const x={a:1};" "EOF"`;
    expect(embeddedBashCommand(command)).toBeUndefined();
  });

  test("adds line breaks to shell pipes without changing embedded source", () => {
    const command = "printf ready | cat; cat > /tmp/demo.js <<'JS'\nconst either = left | right;\nJS\nnode /tmp/demo.js | cat";
    const html = renderEmbedded(command);
    expect(renderedText(html).match(/\|\n/g)).toHaveLength(2);
    expect(renderedText(html)).toContain("left | right");
  });

  test("does not add line breaks to pipes in shell strings", () => {
    const command = "grep -n '^const editorHighlightStyle\\|\n^const filesClientModule' index.ts; nl -ba style.css | sed -n '35,120p'";
    expect(formatBashCommandForDisplay(command)).toBe(
      "grep -n '^const editorHighlightStyle\\|\n^const filesClientModule' index.ts\nnl -ba style.css |\n  sed -n '35,120p'",
    );
  });

  test("keeps short OR operands inline while preserving escaped pipes, strings, and comments", () => {
    const command = String.raw`printf foo\|bar; echo "left | right"; true || false # not a | pipeline`;
    expect(formatBashCommandForDisplay(command)).toBe(String.raw`printf foo\|bar
echo "left | right"
true || false # not a | pipeline`);
  });

  test("splits OR operands longer than ten characters", () => {
    expect(formatBashCommandForDisplay("attempt || echo fail")).toBe("attempt || echo fail");
    expect(formatBashCommandForDisplay("attempt || echo failed")).toBe("attempt ||\n  echo failed");
    expect(formatBashCommandForDisplay("attempt ||\n  echo fail")).toBe("attempt ||\n  echo fail");
  });

  test("formats packed shell control flow without simplifying expressions", () => {
    const command = "for i in $(seq 1 60); do status=$(curl -sS example.test); if grep -q ready /tmp/status; then echo ready-$i-$status; break; fi; echo waiting; sleep 2; done; rg ready /tmp/status | tail -20";
    expect(formatBashCommandForDisplay(command)).toBe(`for i in $(seq 1 60); do
  status=$(curl -sS example.test)
  if grep -q ready /tmp/status; then
    echo ready-$i-$status
    break
  fi
  echo waiting
  sleep 2
done
rg ready /tmp/status |
  tail -20`);
    expect(formatBashCommandForDisplay("(( $foo + ${bar} ))")).toBe("(($foo + ${bar}))");
  });

  test("falls back to pipeline-only formatting for incomplete streamed commands", () => {
    expect(formatBashCommandForDisplay("for i in 1 2; do echo $i; printf x | cat")).toBe("for i in 1 2; do echo $i; printf x |\ncat");
    const heredoc = "cat > /tmp/incomplete.js <<'JS'\nconst either = left | right;\nJS\nif true; then";
    expect(formatBashCommandForDisplay(heredoc)).toContain("left | right");
  });

  test("handles pipe patterns sampled from historical agent sessions", () => {
    const samples = [
      {
        name: "jq expressions alongside shell pipelines",
        command: `curl https://example.test/models | jq -r 'to_entries[] | select(.key | contains("kimi")) | [.key] | @tsv' | head`,
        expected: `curl https://example.test/models |\n  jq -r 'to_entries[] | select(.key | contains("kimi")) | [.key] | @tsv' |\n  head`,
      },
      {
        name: "pipeline in command substitution",
        command: `docker image inspect $(docker images -q 'atelier:*' | head -1) | jq .`,
        expected: `docker image inspect $(docker images -q 'atelier:*' |\n  head -1) |\n  jq .`,
      },
      {
        name: "pipeline in process substitution",
        command: `mapfile -t tests < <(find packages -name '*.test.ts' | sort | grep -v integration); bun test "\${tests[@]}"`,
        expected: `mapfile -t tests < <(find packages -name '*.test.ts' |\n  sort |\n  grep -v integration)\nbun test "\${tests[@]}"`,
      },
      {
        name: "quoted nested shell command",
        command: `docker exec app sh -lc 'cat startup.log | tail -20 || true' | tee inspection.log`,
        expected: `docker exec app sh -lc 'cat startup.log | tail -20 || true' |\n  tee inspection.log`,
      },
    ];
    for (const sample of samples) {
      expect(formatBashCommandForDisplay(sample.command), sample.name).toBe(sample.expected);
    }
  });

  test("formats and highlights static interpreter eval arguments", () => {
    const samples = [
      { name: "bun", command: `bun -e "const answer={value:42};console.log(answer);"`, language: "typescript", statement: "console" },
      { name: "node", command: `node --eval 'const answer={value:42};console.log(answer);'`, language: "javascript", statement: "console" },
      { name: "Python", command: `python3 -c "answer={'value':42}; print(answer)"`, language: "python", statement: "print" },
    ];
    for (const sample of samples) {
      const html = renderEmbedded(sample.command);
      expect(html, sample.name).toContain(`language-${sample.language}`);
      expect(html, sample.name).toContain(sample.statement);
      expect(html, sample.name).toContain("\n");
    }
  });

  test("highlights static ripgrep patterns as embedded regular expressions", () => {
    const samples = [
      `rg -n 'TODO|FIXME|HACK' packages apps --glob '!*.generated.ts'`,
      `rg -n 'export\\s+(async\\s+)?function\\s+(?<name>[A-Za-z_]\\w*)' --glob '*.ts'`,
      `rg -Un '(?s)<dialog\\b[^>]*>.*?</dialog>' apps/web`,
    ];
    for (const command of samples) {
      expect(renderEmbedded(command), command).toContain('class="language-regex"');
      expect(embeddedBashCommand(command)?.differs, command).toBe(false);
    }

    const structural = renderEmbedded(samples[1]!);
    expect(renderedText(structural)).toContain("name");
    expect(structural).toContain('class="syntax-keyword"');
    expect(renderEmbedded(samples[0]!)).toContain('class="syntax-keyword">|</span>');
  });

  test("recognizes positional and explicit ripgrep patterns without highlighting option arguments", () => {
    const html = renderEmbedded(`rg --glob '*.ts' -e 'TODO|FIXME' --regexp '^HACK\\b' packages`);
    expect(html.match(/class="language-regex"/g)).toHaveLength(2);
    expect(html).toContain(`<span class="language-regex">TODO`);
    expect(html).not.toContain(`class="language-regex">*.ts`);
  });

  test("leaves dynamic or shell-transformed patterns and regex-like arguments to other commands opaque", () => {
    expect(embeddedBashCommand(`rg "$pattern" packages`)).toBeUndefined();
    expect(embeddedBashCommand(String.raw`rg "\\s+" packages`)).toBeUndefined();
    expect(embeddedBashCommand(`grep -E 'TODO|FIXME' packages`)).toBeUndefined();
    expect(embeddedBashCommand(`printf '%s' 'TODO|FIXME'`)).toBeUndefined();
  });

  test("escapes regex literals while adding semantic highlighting", () => {
    const html = renderEmbedded(`rg '^(?<tag><[a-z]+>)$' index.html`);
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
    expect(html).not.toContain("<[a-z]");
  });

  test("recursively formats shell arguments passed to bash and tmux", () => {
    const command = `bash -lc 'cd /work && tmux new-session -d -s demo "cd /tmp && python3 -m http.server 3001"'`;
    const html = renderEmbedded(command);
    expect(html.match(/<span class="language-bash"/g)).toHaveLength(2);
    expect(html.match(/class="agent-bash-and"/g)).toHaveLength(2);
  });

  test("leaves dynamically expanded shell arguments opaque", () => {
    expect(embeddedBashCommand(`node -e "console.log('$HOME')"`)).toBeUndefined();
    expect(embeddedBashCommand("python3 -c \"print(`date`)\"")).toBeUndefined();
  });

  test("formats command-bearing strings sampled from historical agent transcripts", () => {
    const playwright = `cd /work && (tmux kill-session -t prototype 2>/dev/null || true) && tmux new-session -d -s prototype 'cd /work/apps/web/public && python3 -m http.server 3001' && sleep 1 && curl -I http://127.0.0.1:3001/prototype.html && bun -e "import { chromium } from 'playwright'; const b=await chromium.launch({headless:true}); const p=await b.newPage({viewport:{width:1440,height:900}}); await p.goto('http://127.0.0.1:3001/prototype.html'); await b.close();"`;
    const formatted = formatBashCommandForDisplay(playwright);
    expect(formatted).toContain("cd /work &&\n");
    expect(formatted).toContain("2>/dev/null || true) &&\n");
    expect(formatted.split("\n").length).toBeGreaterThan(5);
    const playwrightHtml = renderEmbedded(playwright);
    expect(playwrightHtml).toContain("language-typescript");
    expect(playwrightHtml).toContain("language-bash");
    expect(playwrightHtml.match(/<span class="language-(?:bash|typescript)"/g)).toHaveLength(2);
    expect(playwrightHtml).toContain("await");
    expect(playwrightHtml).toContain('class="syntax-string">&#39;</span>');
    expect(playwrightHtml).toContain('<span class="agent-bash-and">&amp;&amp;</span>');
    expect(renderedText(playwrightHtml)).toContain("sleep 1 &&\n");

    const docker = `docker exec app sh -lc 'cat startup.log | tail -20 || true' | tee inspection.log`;
    const dockerHtml = renderEmbedded(docker);
    expect(dockerHtml).toContain('<span class="language-bash">');
    expect(renderedText(dockerHtml)).toContain("startup.log |\n");
    expect(renderedText(dockerHtml)).toContain("-20 || true");
    expect(dockerHtml).toContain('class="agent-bash-or"');
    expect(dockerHtml).not.toContain('<span class="agent-bash-or">||</span>\n');
  });

  test("formats multiple heredoc writes in one bash call", () => {
    const command = "mkdir -p /tmp/demo; cat > /tmp/one.js <<'JS'\nconst one={n:1};\nJS\ncat > /tmp/two.ts <<'TS'\nconst two={n:2};\nTS\nnode /tmp/one.js";
    const html = renderEmbedded(command);
    expect(renderedText(html)).toContain("one = { ");
    expect(renderedText(html)).toContain("two = { ");
    expect(html).toContain("language-javascript");
    expect(html).toContain("language-typescript");
    expect(renderedText(html)).toContain("node /tmp/one.js");
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
      expect(html, sample.name).toContain("syntax-");
    }
  });

  test("does not treat interpreter heredocs nested inside a written shell script as outer commands", () => {
    const command = "cat > /tmp/run.sh <<'SH'\npython3 - <<'PY'\nprint(42)\nPY\nSH";
    const html = renderEmbedded(command);
    expect(html).toContain('<span class="language-bash">');
    expect(html).not.toContain('class="language-python"');
  });

  test("returns no override for unknown stdin heredocs", () => {
    expect(embeddedBashCommand("sed 's/a/b/' <<'EOF'\na\nEOF")).toBeUndefined();
  });
});
