---
name: atelier-demo-video
description: Record and present polished Atelier product-demo videos with the repository's Playwright and FFmpeg harness. Use for presenting your work, demo-videos, walkthrough, or product-recording requests.
---

# Atelier product-demo video

Record inside an Atelier workspace. The harness owns Chromium recording, human pacing, failure diagnostics, H.264 encoding, and metadata; keep scenario code focused on the product workflow.

## Procedure

1. Start Atelier on port 3000 in tmux with `bun run web`. Watch that session and do not record until it logs `[assets] ready`.
2. Copy or adapt the deterministic executable example at `apps/web/demo/recording/example.ts`. Import `recordAtelierDemo` from `apps/web/demo/recording/atelier-recording.ts`, then use its `page`, `humanClick`, `humanType`, and `pauseAfterAction` APIs. Keep selectors in the scenario—never add a selector inventory to this skill.
3. Use the standard 1440x900 viewport and 25 fps defaults. Human helpers default to a short anticipatory pause, 65 ms per typed key, and a settling pause. Override timings only to clarify unusually fast/slow UI or to shorten a deterministic fixture; do not replace them with instant Playwright actions in a product demo.
4. Write final videos under `/work/artifacts`, normally `/work/artifacts/<name>.mp4`. A direct example is:

   ```bash
   bun apps/web/demo/recording/example.ts /work/artifacts/demo.mp4
   ```

5. Prefer `recordAtelierDemo(...)`, which catches scenario failures while preserving and rethrowing the original error. Inspect `<name>.raw.webm` and `<name>.failure.png` in the configured artifact directory after a failure. The raw WebM is retained after successful recordings too.
6. Review the complete MP4 or representative frames before presenting it. Check that the story is legible, waits are natural, no loading/error state was captured, and the returned report shows the expected dimensions and 25 fps.
7. Present the result inline:

   ```md
   ![](atelier-embed:/work/artifacts/demo.mp4)
   ```

The executable example is the canonical usage reference. Read it rather than duplicating its selectors or markup here.
