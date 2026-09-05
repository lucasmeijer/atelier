# UI Prototype

Build **one throwaway HTML file containing several meaningfully different UI directions**. The user should be able to move through the design space in the browser, compare options in realistic context, and identify which parts to combine.

If the question is about logic or state transitions rather than visual and interaction design, use [LOGIC.md](LOGIC.md). It still produces HTML and follows the same Atelier design-system rules.

## Non-negotiable: extend Atelier, do not invent a parallel visual language

A prototype for this repository is not a stand-alone microsite. It is an exploratory Atelier surface.

Before writing the prototype:

1. Read `packages/design-system/README.md` and `packages/design-system/src/design-system.css`, then inspect `/design-system-catalogue.html` in the browser.
2. Inspect the real Atelier page or nearby feature that will host the eventual design. Reuse its information density, shell, terminology, and representative data.
3. Inventory the existing design-system elements that fit the prototype. Prefer those elements over custom equivalents.

The HTML must load the repository's actual `/design-system.css` (owned by `packages/design-system`) with a `<link>`; **never copy, inline, fork, or approximately recreate it**. Place prototypes under `apps/web/public/prototypes/` by default so they can use `../design-system.css` and be served by Atelier. Directly use the shipped classes (`button`, `button-group`, `toggle`, `text-field`, `textarea`, `action-item`, `popup-menu`, status elements, and others shown in the catalogue) wherever they match the intended semantics.

Custom CSS is allowed only for prototype-specific composition and layout that the design system does not provide. It must use Atelier tokens for typography, spacing, radii, color, and elevation. Do not introduce arbitrary hex colors, shadow recipes, font stacks, button styles, form styles, or a second token layer. If an existing element is close but not perfect, use it unchanged and note the gap; discovering a missing design-system element is useful prototype output.

These constraints are the stable foundation, not one of the design variables. Explore hierarchy, grouping, navigation, disclosure, density, and workflow while keeping Atelier's visual language constant across variants.

## When this is the right shape

- “What should this page look like?”
- “Show me a few options before we commit.”
- “Explore different layouts or interaction models for this feature.”
- Any question best answered by comparing tangible UI directions rather than discussing abstract mockups.

## Process

### 1. State the question and design axes

Default to **3 variants**; never exceed 5. At the top of the file, visibly state:

- the question the prototype answers;
- which dimensions are intentionally changing between variants;
- which Atelier context and existing design-system elements are held constant.

For example: “Three ways to organize workspace filters: persistent sidebar, inline disclosure, and command-style popup. All use Atelier's existing action items, buttons, fields, spacing, and Nord theme.”

### 2. Make the HTML a useful design-space explorer

Use one HTML file with small inline JavaScript only for interaction. Give it an obvious prototype control bar, visually separated from the candidate UI, with:

- previous and next controls;
- the current variant's letter and descriptive name;
- a compact overview or menu that can jump directly to every variant;
- a short rationale stating what that variant optimizes and compromises;
- a theme control when color-theme behavior is relevant;
- URL state such as `?variant=b` so a direction can be shared and survives reload.

Support left/right arrow keys, except while an input, textarea, select, or editable region has focus. Make the explorer responsive enough to evaluate both narrow and wide layouts when the question calls for it.

The explorer chrome itself must also use Atelier design-system classes and tokens. Label it clearly as prototype tooling so it is not mistaken for the proposed product UI.

### 3. Create genuinely different directions

Variants must disagree structurally: information hierarchy, grouping, navigation model, primary affordance, or interaction flow. Color changes and minor spacing differences are not variants. If two directions reduce to the same card grid, replace one.

Keep all variants grounded in the same realistic data and application context so comparison is fair. Exercise meaningful states—populated, selected, pending, empty, disabled, or error—when those states affect the question. Controls that imply an interaction should work far enough to judge that interaction, using in-memory state only.

Do not abstract the variants into a shared layout. Reusing actual design-system elements is required; sharing away the structural differences being explored is not.

### 4. Keep the artifact simple

- One hand-authored `.html` file, with prototype-only CSS and JavaScript inline.
- The repository design-system stylesheet remains external and authoritative.
- No framework, bundler, package, production route, database, or real mutation.
- No tests or production-grade abstraction.
- Include a top-of-file comment marking the file as a throwaway prototype and naming the design question.

Run Atelier with `bun run web` and open the prototype's served URL. Do not make the user locate or prepare it manually.

### 5. Hand it over as findings, not just options

Give the user the URL and variant keys. Summarize each direction in one sentence and explicitly call out:

- existing design-system elements reused;
- any missing or strained element discovered;
- the decisions the prototype is intended to elicit.

Feedback like “the hierarchy from B with the disclosure from C” is a successful outcome.

### 6. Capture the answer and clean up

Once a direction wins, record which parts won and why. Implement the validated result properly in the real server-rendered Atelier UI; do not promote prototype markup directly. Preserve the exploratory file on a throwaway branch as described in [SKILL.md](SKILL.md), and remove it from main.

## Anti-patterns

- Building a polished stand-alone mini-product unrelated to Atelier's shell or density.
- Copying design-system CSS into the file, redefining an existing component, or approximating Atelier with bespoke styles.
- Using raw `<button>`, `<input>`, or menu styling where a shipped class already exists.
- Treating theme, color, or decoration as the primary difference between variants.
- Showing toy data or isolated cards when realistic app context is available.
- Creating separate pages that are hard to compare instead of one navigable HTML explorer.
- Wiring the prototype to production mutations or promoting throwaway markup directly.
