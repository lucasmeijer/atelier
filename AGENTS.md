# Agent instructions

Do not commit or push changes unless explicitly requested by the user.

When working on the web app, prefer server-rendered HTML over client-rendered UI.

- Prefer Turbo Frames and Turbo Streams for webpage/server interactions whenever possible.
- Have endpoints return server-rendered HTML or `text/vnd.turbo-stream.html` responses instead of JSON that client JavaScript turns into DOM.
- Use client JavaScript only for behavior that cannot reasonably be expressed server-side, such as WebSocket terminals, focusing/activating tabs, dialogs, or browser-only APIs.
- When JavaScript is necessary, implement it as Stimulus controllers rather than inline scripts or ad-hoc global event listeners.
- Keep Stimulus controllers small and behavior-focused; keep markup generation on the server.
- Never implement fallbacks of migrations unless expliticly asked to do so.
- Do not use defensive programming.  We don't want to swallow errors, we want to notice them. Only be defensive when parsing external inputs.
- Never add a new environment variable to the codebase without explicit instructions to do so. We're striving for minimal configuration, and minimal environment variables.
- Run `bun run generate:workspace-modules` before raw TypeScript checks; otherwise missing ignored generated modules cause cascading unrelated server errors.