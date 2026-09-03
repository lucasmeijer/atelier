# Agent instructions

Do not write UI tests. Follow the [UI testing policy](docs/ui-testing-policy.md).

- When working on the web app, prefer server-rendered HTML over client-rendered UI.
- Prefer Turbo Frames and Turbo Streams for webpage/server interactions whenever possible.
- Have endpoints return server-rendered HTML or `text/vnd.turbo-stream.html` responses instead of JSON that client JavaScript turns into DOM.
- Use client JavaScript only for behavior that cannot reasonably be expressed server-side, such as WebSocket terminals, focusing/activating views, dialogs, or browser-only APIs.
- When JavaScript is necessary, implement it as Stimulus controllers rather than inline scripts or ad-hoc global event listeners.
- Keep Stimulus controllers small and behavior-focused; keep markup generation on the server.
- Be very reluctant in implementing fallbacks or migrations.  The only area that warrants migrations is ateliers ability to not crash when loading older persisted files like settings, workspace settings etc
- Do not use defensive programming.  We don't want to swallow errors, we want to notice them. Only be defensive when parsing external inputs.
- Never add a new environment variable to the codebase without explicit instructions to do so. We're striving for minimal configuration, and minimal environment variables.
- Run `bun run generate:workspace-modules` before raw TypeScript checks; otherwise missing ignored generated modules cause cascading unrelated server errors.
- When presenting the user with the results after an implementation request, run atelier, show it in the preview browser, and use api's you can find in our openapi description to bring the inner atelier to a state/situation where
- your work can immediately be evaluated, without the user having to do more manual preparation steps.
- When controlling or staging an Atelier instance programmatically, follow [docs/automation.md](docs/automation.md).
- Whenever modifying the user interface, use elements from the [Atelier design system catalogue](apps/web/public/design-system-catalogue.html) whenever possible.

Run the development server with `bun run web`. It watches TypeScript, CSS, assets, and server code, automatically reloading open pages after successful changes. Successful asset reloads log `[assets] ready`.

## Agent skills

### Issue tracker

Wayfinder-based planning work is tracked in GitHub Issues using the `gh` CLI. This convention does not apply to other project work. See `docs/agents/issue-tracker.md`.

### Domain docs

For Wayfinder-based work, use the single-context layout with `CONTEXT.md` and system-wide ADRs under `docs/adr/`. See `docs/agents/domain.md`.
