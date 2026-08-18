# Oxlint 1.78.0 OSC hyperlink analysis

## Conclusion

Oxlint 1.78.0 does emit OSC 8 hyperlinks in its default human-readable formatter, but only around a lint diagnostic's rule code when that diagnostic has a documentation URL. It does not put an OSC 8 hyperlink around the reported `filename:line:column` location.

The anti-slop run contained no OSC sequences because its external JavaScript plugin diagnostics did not carry documentation URLs. Therefore Oxlint rendered their rule codes and file locations with CSI/SGR styling only.

This corrects the earlier, overly broad claim that Oxlint 1.78.0 does not emit OSC 8 hyperlinks at all.

## Source inspected

The official repository was cloned at the exact `oxlint_v1.78.0` tag:

- Repository: <https://github.com/oxc-project/oxc>
- Tag commit: [`c42d6397eab5b2d5bb2bd6746c57bc2a9cad21bd`](https://github.com/oxc-project/oxc/tree/c42d6397eab5b2d5bb2bd6746c57bc2a9cad21bd)
- The npm package identifies this repository and `npm/oxlint` directory as its source: [`npm/oxlint/package.json`](https://github.com/oxc-project/oxc/blob/c42d6397eab5b2d5bb2bd6746c57bc2a9cad21bd/npm/oxlint/package.json)

## Findings

### 1. The default formatter delegates to `GraphicalReportHandler`

Oxlint's default reporter constructs `GraphicalReportHandler::new()` and sends each diagnostic to `render_report` without disabling links:

- [`apps/oxlint/src/output_formatter/default.rs#L113-L131`](https://github.com/oxc-project/oxc/blob/c42d6397eab5b2d5bb2bd6746c57bc2a9cad21bd/apps/oxlint/src/output_formatter/default.rs#L113-L131)

Its snapshot-test reporter explicitly calls `.with_links(false)` because “links print ansi escape codes,” confirming links are enabled in the production default reporter:

- [`apps/oxlint/src/output_formatter/default.rs#L177-L181`](https://github.com/oxc-project/oxc/blob/c42d6397eab5b2d5bb2bd6746c57bc2a9cad21bd/apps/oxlint/src/output_formatter/default.rs#L177-L181)

### 2. Built-in lint diagnostics receive a rule-documentation URL

The built-in linter context attaches both the rule code and a URL under `https://oxc.rs/docs/guide/usage/linter/rules/...`:

- [`crates/oxc_linter/src/context/mod.rs#L254-L266`](https://github.com/oxc-project/oxc/blob/c42d6397eab5b2d5bb2bd6746c57bc2a9cad21bd/crates/oxc_linter/src/context/mod.rs#L254-L266)

The diagnostic type exposes that URL to the renderer:

- [`crates/oxc_diagnostics/src/lib.rs#L277-L285`](https://github.com/oxc-project/oxc/blob/c42d6397eab5b2d5bb2bd6746c57bc2a9cad21bd/crates/oxc_diagnostics/src/lib.rs#L277-L285)

### 3. The hyperlink feature was explicitly implemented for diagnostic codes

The originating change is [`9c22ce9c995668a7b96b5c1f126c1b20298210a9`](https://github.com/oxc-project/oxc/commit/9c22ce9c995668a7b96b5c1f126c1b20298210a9), titled “add hyperlinks to diagnostic messages.” Its description says “Adds hyperlinks to diagnostic codes,” and its renderer patch emits:

```text
ESC ] 8 ; ; <rule-documentation-url> ESC \
<diagnostic-code>
ESC ] 8 ; ; ESC \
```

The implementation wraps the diagnostic code, not the source filename or location.

### 4. Runtime verification agrees with the source

Running a built-in `eslint/no-debugger` diagnostic through a raw PTY produced two OSC 8 markers (open and close) around `eslint(no-debugger)`, pointing to:

```text
https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-debugger.html
```

The subsequent `oxlink.js:1:1` location had CSI/SGR color escapes but no OSC wrapper.

The anti-slop run's raw PTY output contained zero OSC sequences. Its vendored rules provide a `meta.docs.description` but no documentation URL, for example:

- [`tools/oxlint/anti-slop/rules/no-runtime-typeof.ts`](../../tools/oxlint/anti-slop/rules/no-runtime-typeof.ts)

Consequently there is no URL for the default renderer to attach to the anti-slop rule code. Regardless, Oxlint's built-in hyperlink behavior does not hyperlink filenames.

## Implication for Atelier

Atelier cannot rely on Oxlint to make `path:line:column` clickable. It should add a terminal-side file-location link provider (or equivalent problem matcher). OSC 8 support remains useful for the rule-documentation links Oxlint already emits.
