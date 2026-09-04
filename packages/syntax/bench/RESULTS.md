# Highlighting results — 2026-09-04

Apple M4 Max, macOS arm64, Bun 1.3.14; same fixture bytes as the baseline.
52/52 cases pass the tightened budgets documented in README.md. No server deployment or local Atelier launch.

## First invocation / third invocation (ms)

| Fixture | Syntax | Markdown | Write | Read | Bash | Review | Tool diff | Editor |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| style.css | 9.8 / 0.0 | 10.1 / 0.1 | 10.6 / 0.2 | 10.5 / 0.2 | 21.0 / 0.5 | 15.7 / 0.3 | 15.7 / 0.3 | 9.6 / 2.4 |
| view.js | 9.0 / 0.0 | 9.9 / 0.1 | 10.4 / 0.2 | 10.5 / 0.2 | 43.6 / 6.0 | 154.6 / 18.7 | 158.9 / 22.3 | 9.9 / 3.1 |
| board.js | 6.1 / 0.0 | 6.5 / 0.0 | 7.2 / 0.2 | 6.8 / 0.2 | 36.5 / 4.0 | 75.4 / 1.4 | 75.8 / 1.6 | 6.0 / 1.1 |
| constructor.js | 6.6 / 0.0 | 6.6 / 0.0 | 7.1 / 0.2 | 7.4 / 0.2 | 25.8 / 2.2 | 6.0 / 0.1 | 6.2 / 0.1 | 6.4 / 1.0 |
| index.html | 7.5 / 0.0 | 8.4 / 0.1 | 8.2 / 0.2 | 8.5 / 0.2 | 19.5 / 0.6 | 6.9 / 0.1 | 6.5 / 0.1 | 9.2 / 1.4 |

## Complete streaming replays

Every prefix is rendered: these results do not take credit for runtime coalescing.

| Fixture | Path | Chunk chars | Total work (ms) | Max update (ms) | Updates |
|---|---|---:|---:|---:|---:|
| style.css | write | 32 | 310.6 | 3.4 | 303 |
| style.css | write | 256 | 54.6 | 4.1 | 38 |
| style.css | write | 2048 | 18.4 | 7.1 | 5 |
| style.css | markdown | 32 | 286.9 | 2.9 | 302 |
| style.css | markdown | 256 | 51.2 | 4.4 | 38 |
| style.css | markdown | 2048 | 16.2 | 6.3 | 5 |
| view.js | write | 32 | 186.7 | 3.3 | 179 |
| view.js | write | 256 | 36.3 | 4.5 | 23 |
| view.js | write | 2048 | 14.0 | 8.1 | 3 |
| view.js | markdown | 32 | 174.2 | 2.7 | 177 |
| view.js | markdown | 256 | 34.9 | 4.0 | 23 |
| view.js | markdown | 2048 | 13.1 | 7.4 | 3 |

## Interpretation

The original 32-character CSS and JavaScript write replays exceeded the 10-second
watchdog before completing. They now finish in a fraction of a second. Shared
server highlights all remain below 20 ms in this run, including first invocations.
Repeated identical-source timings include real cache hits. The separate streaming
measurements demonstrate improvement on changing inputs that cannot hit that cache.

Pierre remains a separate implementation: its first JavaScript render is still
around 150 ms, with repeats around 20 ms. That is a recorded exception to the
50 ms render target, not a solved cold-start problem. It retains its normal
long-line tokenization cutoff. No guarantee is made for arbitrary languages/input.

Oniguruma alone was insufficient for the shared server path: an intermediate run
still needed roughly 8.7 seconds for the 32-character CSS write replay. Switching
the common web languages to Lezer removed the captured regex bottleneck.

See [baseline.json](baseline.json), [after.json](after.json), and [README.md](README.md).
