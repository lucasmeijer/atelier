# Domain docs

These conventions apply only when using the Wayfinder workflow. They do not establish GitHub Issues or domain documentation as requirements for other Atelier work.

How Wayfinder should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. Domain-modeling work creates them lazily when terms or decisions actually get resolved.

## File structure

Atelier uses a single-context layout for Wayfinder-based work:

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
├── apps/
└── packages/
```

## Use the glossary's vocabulary

When Wayfinder output names a domain concept in an issue title, proposal, hypothesis, or test name, use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use or there's a real gap to resolve through domain modeling.

## Flag ADR conflicts

If Wayfinder output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
