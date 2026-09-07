# Captured highlighting performance regression

Run from the repository root:

```sh
bun run generate:workspace-modules
bun test packages/syntax/test/repro.test.ts
bun test ./packages/syntax/bench/repro.perf.ts
```

The regular suites verify captured inputs, parser token ranges, bounded cache reuse,
and server streaming lifecycle. The opt-in performance suite checks **20 ms per
shared server highlight**, **50 ms per render**, and **1 second per complete
streaming replay**, with a **10-second external watchdog**. Pierre's cold first
render has an explicit **200 ms exception** because engine/grammar initialization
still exceeds 50 ms. Repeated Pierre renders use the 50 ms budget.
Timing gates are opt-in (`.perf.ts` rather than `.test.ts`) to avoid introducing
machine-dependent timing assertions into normal CI. See [RESULTS.md](RESULTS.md)
for the measured improvement and remaining limits; [BASELINE.md](BASELINE.md)
records the original behavior.

Select a smaller case by test name:

```sh
bun test ./packages/syntax/bench/repro.perf.ts -t 'style.css / write'
bun test ./packages/syntax/bench/repro.perf.ts -t 'view.js / syntax'
bun test ./packages/syntax/bench/repro.perf.ts -t 'editor'
```

To inspect one case without a timing assertion, call the child directly (this
does **not** have the parent's external timeout):

```sh
bun packages/syntax/bench/child.ts syntax constructor.js 0
```

## What is exercised

| Path | Production code exercised |
| --- | --- |
| syntax | `highlightCodeHtml` including parser/Shiki tokenization, caching and theme conversion |
| markdown | Markdown fenced code; `StreamingMarkdownRenderer` for prefix cases |
| write | `renderActiveToolContent` and its real partial-JSON write parser, inline/fullscreen highlighting |
| read | Actual read preview and fullscreen highlighting |
| bash | Embedded heredoc detection and highlighting via `embeddedBashCommand` |
| review | Pierre `DiffHunksRenderer` with `reviewDiffOptions` |
| tool-diff | Pierre `DiffHunksRenderer` with `toolDiffOptions` |
| editor | CodeMirror language selection, full syntax parsing and `highlightTree`, without a DOM |

Every path uses all five captured fixtures. Full cases run three times in a
fresh process: first use and two repeats. Stream cases use CSS and view.js with
32-, 256-, and 2,048-character chunks. Write cases split serialized arguments,
including JSON escape sequences and incomplete strings, then pass each complete
prefix to the actual renderer. Markdown cases split fenced-code contents.
Every synthetic prefix is rendered, deliberately bypassing runtime coalescing.
This measures worst-case repeated-prefix cost independently of provider timing;
server lifecycle tests separately exercise actual delta coalescing.

There are no UI, markup, or screenshot assertions. Function spies count calls
while always executing the real syntax implementation. No production interface
or behavior is changed for testing. The counters cover the shared server
highlighter; Pierre and CodeMirror are separate implementations and report zero
server-highlight calls, not zero tokenization work.

Counts describe public highlighter requests and characters submitted, not internal
regex attempts. Both public entrypoints execute their original implementation;
cache hits in either entrypoint are therefore reflected in timings.

## Interpreting output

Each test prints a JSON record with runtime/platform, per-update duration, total
time, maximum update duration, highlighter call count, total characters passed to
the shared highlighter, and maximum single highlight duration. Import/setup is
outside sample timing; lazy initialization during the first invocation is included.
CPU warmup and caches are deliberately visible in the three full samples.

The parent process owns the watchdog. A timer inside the highlighting process
cannot interrupt a synchronous regex. When killed, only **completed** samples
are reported: totals are lower bounds and exclude the unfinished call. The
10-second watchdog includes process startup and is a harness safety limit,
not a proposed production timeout. The assertions are regression budgets for this corpus and machine class,
not guarantees about all possible input or target hardware.

The Pierre cases include awaited rendering and initialization time; their
elapsed time should not be interpreted as a direct measurement of browser event
loop blocking. These tests execute server-side under Bun, not inside a browser.

## Implementation and streaming

The common web languages (JS/TS/JSX/TSX, CSS, HTML with nested scripts/styles,
and JSON) use Lezer's error-tolerant parsers instead of the expensive TextMate
regex path. Other supported languages retain Shiki, now using Oniguruma WASM.
Pierre also selects its WASM engine; the editor already uses Lezer.

The server cache is bounded by 256 entries and 2,000,000 retained UTF-16 units
(source/key plus output). Keys include resolved language. Identical inline and
fullscreen content is highlighted once. Changed prefixes still require parsing.

Tool arguments accumulate immediately, but rendering is coalesced to one flush
per 50 ms while subscribed, slowing to 500 ms once accumulated arguments reach
2 KiB in UTF-8 (roughly the historical 95th percentile). An already scheduled
50 ms flush may finish; subsequent flushes use the slower cadence. Each new tool
call starts with the fast cadence again. Completion flushes immediately and cancels
pending work; unsubscribe/disposal also cancels pending work. Assistant text flushes all
available text every 50 ms instead of manufacturing 24-character updates every
16 ms. Partial JSON parsing occurs at rendering, not on each delta.

Before this change, every tool delta rendered the entire prefix twice. For N
characters in k equal chunks, that visits approximately N × (k + 1) characters.
Small deltas therefore can amplify this incident. The saved session does not
establish the actual provider chunk sizes or their contribution to that run.
The streaming benchmarks deliberately render *all* synthetic prefixes, so their
improvement does not depend on coalescing or an assumed arrival rate.

Pierre retains its default 1,000-character per-line tokenization limit. Its
results on long lines therefore do not mean it fully highlights those lines.
The shared server parser does process the captured long lines in full. Moving
work to a worker is not part of this change. This corpus does not establish a
hard wall-clock bound for arbitrary input, especially the remaining TextMate
languages or Pierre's cold initialization.
