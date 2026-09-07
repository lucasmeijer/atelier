# Module-owned workspace-pane actions

A module can implement `WorkspaceModule.renderWorkspacePaneActions(): string` to
contribute server-rendered HTML to the workspace pane header. The app renders
these actions in module registration order, immediately before Settings and the
pane-collapse control. This is one curated slot, not a configurable toolbar.

Use icon-only design-system Action links with accessible labels. Return initial
markup synchronously; do not fetch external state while rendering the shell.
The module owns subsequent Turbo Frame or Turbo Stream requests, routes,
OpenAPI descriptions, styles, and Stimulus controllers through the existing
module contributions. Return an empty string when there is no action to show.

## Dialogs and direct navigation

`workspaceModuleModalFrameId` names the shell's shared Turbo Frame. Module action
links can target it. A matching route returns that frame containing a
server-rendered design-system dialog for a Turbo Frame request. For a direct
browser request, call `WorkspaceModuleRouteContext.renderModalPage(dialogHtml)`
with the dialog itself, without the frame wrapper. The app renders the normal
Atelier shell, supplies the frame, and places the dialog inside it. There is one
active module dialog at a time; modules do not add permanent private modal hosts.
JSON and other response formats remain the module route's responsibility.

## Usage

The Agent module owns the complete Usage feature:

- `packages/agent/src/server/usage-web.ts`: header action, dialog, and routes.
- `packages/agent/src/server/usage-openapi.ts`: endpoint descriptions and schemas.
- `packages/agent/src/client/usage-controllers.ts`: provider selection and refresh.
- `packages/agent/src/client/usage.css`: feature-specific presentation.
- Agent-owned provider adapters, pacing, and the local token ledger supply data.

`web.ts`, `static.ts`, and `agent-controllers.ts` assemble these contributions.
The app does not import Usage or know its routes, provider state, or ring values.
The comparison ring remains a reusable design-system Action link capability.
The `/usage` URLs and JSON representations are unchanged.
