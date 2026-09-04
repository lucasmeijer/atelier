# Highlighting baseline — 2026-09-04

Apple M4 Max, macOS arm64, Bun 1.3.14. Production ran Bun 1.4.0 on Linux x64; these are local reproduction measurements, not interchangeable server timings. No application highlighting behavior changed.

**52 performance cases: 16 pass, 36 fail the performance/process budgets.** The fixture/harness tests and existing syntax tests pass (9 total); lint and TypeScript checks pass.

## Full fixture: first invocation / third invocation (ms)

Each cell comes from a fresh process for that fixture/path. Imports precede timing; lazy first-use initialization is included. Read/write cases include both inline and fullscreen work.

| Fixture | Syntax | Markdown | Write | Read | Bash | Review | Tool diff | Editor |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| style.css | 533.4 / 501.8 | 534.8 / 501.7 | 1037.7 / 1003.6 | 1035.8 / 1005.2 | 560.5 / 502.0 | 36.3 / 0.3 | 36.1 / 0.3 | 9.8 / 2.8 |
| view.js | 1922.1 / 805.9 | 1873.3 / 834.0 | 2852.0 / 1651.3 | 2872.0 / 1657.2 | 1828.1 / 578.8 | 1607.1 / 322.9 | 1598.7 / 326.3 | 11.1 / 2.6 |
| board.js | 1418.9 / 346.1 | 1432.7 / 342.9 | 1776.6 / 685.6 | 1767.2 / 683.9 | 1144.9 / 32.2 | 930.0 / 7.3 | 955.3 / 7.4 | 6.6 / 1.1 |
| constructor.js | 663.2 / 502.4 | 653.1 / 501.0 | 1168.8 / 1004.8 | 1167.1 / 1005.2 | 1108.0 / 507.3 | 10.7 / 0.1 | 7.3 / 0.1 | 7.4 / 1.1 |
| index.html | 51.8 / 10.0 | 52.5 / 10.7 | 71.1 / 20.4 | 67.7 / 20.2 | 88.6 / 12.3 | 8.0 / 0.1 | 6.8 / 0.1 | 9.7 / 1.6 |

## Synthetic streaming replay

Write chunks split serialized tool-argument JSON; Markdown chunks split code text. No provider arrival timing is replayed. Timeouts exclude the unfinished update, so their totals and maxima are lower bounds.

| Fixture | Path | Chunk chars | Updates completed / planned | Highlight calls completed | Total completed work (ms) | Max completed update (ms) | Result |
|---|---|---:|---:|---:|---:|---:|---|
| style.css | write | 32 | 99 / 303 | 198 | 9387.8 | 287.2 | timeout |
| style.css | write | 256 | 24 / 38 | 48 | 8990.4 | 985.6 | timeout |
| style.css | write | 2048 | 5 / 5 | 10 | 3913.1 | 1005.5 | over-budget |
| style.css | markdown | 32 | 124 / 302 | 124 | 9618.0 | 245.7 | timeout |
| style.css | markdown | 256 | 34 / 38 | 34 | 9687.5 | 502.4 | timeout |
| style.css | markdown | 2048 | 5 / 5 | 5 | 2113.4 | 502.6 | over-budget |
| view.js | write | 32 | 72 / 179 | 144 | 9494.3 | 646.1 | timeout |
| view.js | write | 256 | 18 / 23 | 36 | 8914.2 | 1269.4 | timeout |
| view.js | write | 2048 | 3 / 3 | 6 | 3926.8 | 1623.0 | over-budget |
| view.js | markdown | 32 | 92 / 177 | 92 | 9521.4 | 653.6 | timeout |
| view.js | markdown | 256 | 23 / 23 | 23 | 9168.6 | 1023.3 | over-budget |
| view.js | markdown | 2048 | 3 / 3 | 3 | 2565.9 | 1161.3 | over-budget |

## Findings

- Every completed write update invoked the server highlighter twice. The regular test observes actual calls through a spy that executes the real implementation.
- Dense CSS is slow even after warmup; this is not just startup cost.
- Smaller chunks greatly increase repeated-prefix work. Several replays exceed the external 10-second budget before reaching the complete fixture.
- CodeMirror parsing/highlighting is much faster on this corpus. Pierre has a 1,000-character per-line tokenization limit, yet some JavaScript cases remain slow.
- The real provider delta sizes are unavailable in the saved session. The replay establishes amplification in the implementation, not the exact contribution to that incident.

See [README.md](README.md) for commands and measurement boundaries, [baseline.json](baseline.json) for machine-readable results, and [fixture provenance](../test/fixtures/slay/README.md) for captured inputs.
