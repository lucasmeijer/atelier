# Atelier design system

Atelier is an **Operate** interface: a compact workspace for running agents, reading their work, and moving between files, terminals, browsers, and settings. The design system preserves the existing quiet, dense shell while making its typography, themes, spacing, shape, and motion predictable.

## Source of truth

The public interface is [`apps/web/public/design-system.css`](apps/web/public/design-system.css). It is loaded before the shell and all workspace-module styles, so every server-rendered surface can consume the same custom properties without importing a package-specific stylesheet.

Use semantic tokens in module CSS. Do not redefine global colors, font scales, line heights, radii, or motion locally. A new token should represent an intent reused at least three times; a one-off layout measurement can remain local.

## Visual character

- **Density:** compact, calm, and scan-friendly rather than spacious or decorative.
- **Surfaces:** restrained solid panels and fine borders; elevation is reserved for dialogs and floating menus.
- **Color:** themes define semantic roles, never module-specific palettes. Accent marks selection and action; green, amber, and red communicate status.
- **Typography:** the sans face is for interface and prose. The mono face is for code, paths, identifiers, terminal output, and measured data only.
- **Shape:** 8–14px radii for ordinary controls and shell surfaces, 18px for dialogs, full pills only for compact status or round controls.
- **Motion:** fast and functional. Honor reduced-motion preferences; do not add decorative looping animation.

## Typography

| Role | Token | Size | Typical use |
| --- | --- | ---: | --- |
| Micro | `--text-2xs` | 10px | metadata and compact code labels |
| Caption | `--text-xs` | 11px | secondary labels and status bars |
| Small UI | `--text-sm` | 12px | menus, secondary controls |
| UI | `--text-ui` | 13px | default controls and shell copy |
| Body | `--text-body` | 14px | readable prose and transcript text |
| Input | `--text-input` | 16px | primary composer input; prevents mobile focus zoom |
| Title | `--text-title` | 17px | dialog and section titles |
| Heading | `--text-heading` | 21px | onboarding and major headings |
| Display | `--text-display` | 28px | empty-state welcome only |

Use `--leading-compact` for dense controls, `--leading-ui` for normal interface copy, and `--leading-copy` for transcript or long-form reading. Half-pixel font-size variants are intentionally excluded.

## Spacing and shape

Spacing follows the named 2px/4px rhythm in the `--space-*` tokens. Prefer tighter spacing within a related group and a larger step between groups. Use the `--radius-*` family instead of introducing near-duplicate radii.

## Color contract

Every theme must provide:

- surfaces: `--bg`, `--panel`, `--elev`
- separators: `--line`, `--line2`
- text: `--text`, `--muted`, `--muted2`
- action: `--accent`, `--accent-soft`
- status: `--green`, `--amber`, `--red` and their `-soft` counterparts
- elevation and progress: `--shadow`, `--spin`

The legacy aliases `--line-2` and `--muted-2` remain part of the interface while existing call sites migrate.

## Shared patterns

Existing shared CSS patterns remain the preferred vocabulary:

- `.btn` with `.primary`, `.danger`, and `.sm` variants for actions
- `.action-item` for an orientation-independent interactive item, with `.action-item__primary`, `.action-item__label` containing `.action-item__label-text`, optional `.action-item__status`, and optional `.action-item__action` children
- `.modal` and native `<dialog>` for protected or interruptive tasks
- `.panel` for a bounded shell region, not as generic page scaffolding
- `.status-spinner` for indeterminate progress
- shell-specific `.fixed-shell-*` patterns for workspace navigation and panes

An Action Item may be arranged vertically or horizontally by its containing interface. A simple item can place both `.action-item` and `.action-item__primary` on one button or link. A compound item uses a neutral `.action-item` container so its primary and auxiliary controls remain sibling interactive elements. Selection comes from `aria-current` or `aria-selected`, not a visual modifier class. Labels truncate by default and automatically scroll their overflowing text while the Action Item is hovered or focused; reduced-motion preferences preserve truncation.

Workspace modules should inherit tokens and own only their layout or domain-specific presentation. Server-rendered HTML remains the source of markup; the design system does not introduce client-side rendering.

## Accessibility

Interactive controls need a visible `:focus-visible` state, text alternatives for icon-only buttons, and complete hover, disabled, loading, error, and empty states where applicable. Use semantic status colors against their paired surfaces. Selection, scrollbars, and editor carets are themed as part of the shipped interface.
