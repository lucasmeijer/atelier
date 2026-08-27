# Logic Prototype

Build one interactive HTML file that lets anyone drive a state model by clicking Atelier UI controls and watching the result. Use this when the question is about **business logic, state transitions, or data shape**—the kind of idea that only becomes clear when exercised through real cases.

The model is the subject, but the artifact is still an Atelier prototype. Follow the shared design-system rules in [SKILL.md](SKILL.md): load `apps/web/public/design-system.css`, reuse its elements, and present the model in the visual and product context where it would eventually live.

If the question is primarily “what should this look like or how should this interaction be organized?”, use [UI.md](UI.md).

## When this is the right shape

- “Does this state machine handle X followed by Y?”
- “Can this data model represent this awkward case?”
- “What should be legal at each point in this workflow?”
- Anything where pressing controls and observing state is more revealing than reading a diagram.

## Process

### 1. State the question

At the top of the demo, visibly state the model and the exact uncertainty being explored. Use domain language, not implementation terminology. Also identify the real Atelier surface this model supports and the existing design-system elements used to represent it.

### 2. Isolate the model

Put the logic in a small, pure module inside the HTML's `<script>`. The page calls the model; the model never reaches into the DOM.

Choose the shape that matches the question:

- a reducer `(state, action) => state` for discrete events over one state value;
- an explicit state machine when legal actions depend on the current state;
- pure functions over plain data when there is no implicit current state;
- a small class or module only when the model genuinely owns ongoing internal state.

The surrounding HTML is throwaway. Keeping the model pure makes the validated idea easy to translate into production code later, but do not over-generalize or prematurely package it.

### 3. Build the HTML explorer

Place one clearly marked file under `apps/web/public/prototypes/` by default. Link `../design-system.css`; do not copy, inline, or reproduce the design system. Use shipped controls such as `.button`, `.button-group`, `.toggle`, `.action-item`, fields, and status indicators wherever their semantics fit. Any prototype-only layout CSS must use Atelier's tokens rather than custom colors, fonts, radii, shadows, or spacing scales.

Lay out the explorer with a clear hierarchy:

1. **Question and context**—what the demo explores and where it belongs in Atelier.
2. **Current state**—all relevant state as readable labelled fields, not merely raw JSON. Highlight what changed after each action using existing status and color roles.
3. **Free play**—one action per control so the model can be exercised in any order. Disable illegal actions when that is part of the model, and explain why.
4. **Guided scenarios**—tabs, toggles, action items, or another appropriate design-system pattern for several walkthroughs. Each scenario explains the setup and what to watch, resets to known initial state, and presents the ordered actions as real controls.
5. **Event history**—when ordering matters, show a compact domain-language history so surprising transitions can be diagnosed.

Include at least a happy path, a difficult edge case, and an illegal or rejected attempt. Use realistic Atelier terminology and representative data. The UI should be polished enough that presentation flaws do not obscure the model, but it should not become an unrelated visual design exercise.

### 4. Keep it simple and evaluable

- One `.html` file with prototype CSS and JavaScript inline; the actual design-system stylesheet remains external and authoritative.
- No framework, bundler, package, database, or production mutation.
- In-memory state and deterministic scenario resets.
- No tests, generic abstractions, or production-grade error handling.
- A top-of-file comment naming the design question and marking the artifact as throwaway.

Run Atelier with `bun run web`, open the served prototype URL, and leave the most revealing scenario selected for review.

### 5. Hand it over

Give the user the URL and briefly list the scenarios. Call out any transition that deserves attention and any missing or strained design-system element discovered while representing the model. The useful response is often “that action should not be possible” or “this state needs another distinction.”

### 6. Capture the answer

Record what the prototype established. Implement the validated model properly in the real module and UI; do not move prototype code directly into production. Preserve the HTML on a throwaway branch and remove it from main as described in [SKILL.md](SKILL.md).

## Anti-patterns

- A generic stand-alone demo that visually ignores Atelier.
- Copying or approximating `design-system.css` instead of linking and using it.
- A raw JSON dump as the only state presentation.
- DOM manipulation inside the model.
- A framework, dev app, real database, or production mutation for a disposable question.
- Happy-path-only scenarios that avoid the uncertainty the prototype exists to settle.
- Shipping the HTML shell or lifting under-tested prototype code directly into production.
