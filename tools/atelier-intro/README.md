# Atelier logo easter egg — terminal edition

A standalone C11 / POSIX ANSI animation of Atelier's existing logo easter egg:
the mark grows eyes, looks at an opening floor portal, panics, stretches, and
falls through. The portal closes. **The logo never returns.**

```sh
make -C tools/atelier-intro
./tools/atelier-intro/atelier-intro
```

One run lasts 1.075 seconds (4× original playback speed). There is deliberately no `--loop` mode, ceiling
portal, return fall, or final repaint of the logo. The spaced `made for humans`
tagline remains, and the shell receives the cursor at column 1 of the bottom
row. Any key skips to this same end state without consuming queued input.

## Rendering and timing

- Terminal-native Unicode Braille (2×4 dots per cell), not a downscaled image.
- Uses the terminal's default foreground/background, an ochre portal, and the
  sage tagline. No background fill, alpha preblending, or palette changes.
- Re-queries PTY dimensions and recomputes centering before every frame at
  60 fps. Resizing re-scales the scene without restarting the timeline.
- Clears at startup, resize, and exit; uses buffered changed-cell output
  between clears. No alternate screen, so the tagline remains after exit.
- Restores SGR, cursor visibility, and input modes on normal exit and catchable
  interruption. SIGHUP/broken output skip final drawing. SIGKILL cannot clean up.
- Redirected stdout and TERM=dumb produce no animation bytes.
- Requires a UTF-8 terminal/font with Braille glyphs and ANSI true color.
  Rendering detail depends on the terminal font and available dimensions.
- No libraries beyond libc/libm, no image/font files, no runtime downloads.

The source geometry and first part of the seven-second animation come from:

- `apps/web/src/server/atelier-easter-egg.ts` (mark, eyes, pupils, mouth, arms,
  floor portal)
- `apps/web/public/style.css` (`atelier-easter-egg-*` keyframes)
- `packages/design-system/src/icons/icons-html.ts` (canonical mark)

The C rendition uses smooth interpolation and terminal-sized strokes rather
than attempting byte/pixel parity with the browser's SVG/CSS rendering. Only
the first 59.2% of the original journey is retained; all return phases are gone.
New interactive Terminal views run the intro automatically. See below.

## Evaluation

Built with `-Wall -Wextra -Wpedantic -Werror`. Manually checked normal completion,
queued input, PTY resizes from 1×1 through 160×48 (including temporary zero size),
bottom-row cursor handoff, and termios restoration under AddressSanitizer and
UndefinedBehaviorSanitizer. Visually reviewed and recorded the complete run in
an Atelier Terminal Work view. No UI tests were added.

An existing web-terminal resize-forwarding issue may leave the underlying PTY
at its original size after a browser resize. The animation uses dimensions
actually reported by the PTY; direct terminal/tmux resizing works independently
of that forwarding issue.

## Automatic terminal startup — no workspace image rebuild

`packages/workspace-terminal/src/server/terminal-intro.ts` installs the intro
on demand when creating a new **interactive** terminal (no explicit command).
Installation/cache lookup and tmux creation share one container call to avoid
an extra Docker round trip. First-client detection polls every 10 ms.
The canonical C source lives beside it at `intro/main.c`; the Makefile in this
directory builds that same source for standalone use.

- Atelier reads the C source shipped with the web server and hashes it together
  with the compiler flags.
- It compiles with the workspace's existing `cc` into
  `/.atelier/terminal-intro/<hash>`. Existing workspace images already include
  GCC; no image change, root install, or new environment variable is required.
- A cached executable is reused. A source change gets a new hash and a new
  native build. Compilation uses a temporary file and atomic rename so parallel
  terminal creation never observes a partial executable.
- The new tmux session waits for its first attached client before running the
  animation, then replaces its startup shell with normal interactive Bash.
- Reconnection, server restart, and attaching an existing tmux session do not
  replay the intro. Explicit command terminals start immediately without it.
- Compilation errors are surfaced as terminal-creation errors, not silently
  ignored. Custom workspace images need a C compiler and libc development files
  for their first build. Cached binaries need no compiler to run.

Server tests cover native installation/cache reuse and immediate explicit
commands. First-attachment playback, bottom-row shell handoff, and reconnect
without replay were manually verified in the running app using an existing
workspace container.
