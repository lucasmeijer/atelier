---
name: prototype
description: Build an interactive HTML prototype on Atelier's real design system to answer a UI, interaction, state-model, or product-design question. Use when the user wants to explore several design directions or make an abstract workflow tangible before implementation.
---

# Prototype

A prototype is **throwaway HTML that answers a design question while remaining recognizably Atelier**. It explores the design space; it does not create a stand-alone visual language.

## Pick a branch

Identify the question from the prompt and surrounding code, or ask when genuinely ambiguous:

- **“What should this look or behave like?”** → [UI.md](UI.md). Build one interactive HTML file with several structurally different directions and controls for quickly comparing them.
- **“Does this logic / state model feel right?”** → [LOGIC.md](LOGIC.md). Build one interactive HTML file with free play and guided scenarios that make transitions tangible.

Both branches produce browser-openable HTML and both must directly use Atelier's existing design system. A backend-centered question usually points to logic; a page, component, or workflow question usually points to UI.

## Rules that apply to both

1. **Use Atelier's design system directly.** Read `apps/web/public/design-system.css` and `apps/web/public/design-system-catalogue.html` first. Link the real stylesheet from the prototype; never copy or recreate it. Use existing classes and elements wherever applicable, and use its tokens for any prototype-specific layout CSS.
2. **Build in context, not in isolation.** Inspect the nearby real UI and carry over Atelier's shell, terminology, realistic data, density, and theme. The prototype should feel like a possible Atelier feature, not a generic mini-app.
3. **Make the design space easy to explore.** Produce one clearly marked HTML file with visible controls, meaningful states, and multiple variants or scenarios. Keep all alternatives together so the user can compare them quickly.
4. **Keep it throwaway and obvious.** Put prototypes under `apps/web/public/prototypes/` by default, close to the real stylesheet and static server, with `prototype` in the filename. Do not add a production route or architecture for the artifact.
5. **Trivial to evaluate.** Run Atelier with `bun run web`, open the served prototype URL, and leave it in the state most useful for review. The user should not need setup instructions beyond the URL.
6. **Use in-memory state.** Do not depend on persistence or production mutations unless persistence itself is the question; then use explicitly disposable data.
7. **Optimize for learning, not shipping.** No tests, defensive scaffolding, framework, new dependencies, or premature abstractions. Add only enough interaction and polish to judge the question accurately.
8. **Surface state and tradeoffs.** After actions and variant changes, make the relevant state visible. Explain what each direction or scenario is meant to reveal.
9. **Capture the answer.** Record the verdict and why. Implement the validated result properly in real code, then preserve the prototype as a primary source on a throwaway branch and remove it from main. Prototype markup is evidence, not production code.
