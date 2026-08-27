# UI testing policy

UI tests should protect durable product behavior without turning the current visual implementation into a permanent compatibility contract. Use the cheapest test layer that can detect the regression.

## Browser tests

Add a real-browser test only when the risk depends on browser behavior, such as:

- focus, keyboard, pointer, or touch handling;
- responsive navigation behavior;
- scrolling or layout-dependent decisions;
- DOM, iframe, or live-view identity;
- Turbo or Stimulus lifecycle behavior;
- integration across multiple server-rendered updates.

Keep each browser test focused on one user-visible behavior. Assert outcomes through roles, accessible names, visibility, state attributes, URLs, requests, and preserved node identity.

Do not add a browser test merely because a gap, radius, width, color, font, icon size, or class changed. Do not compare computed styles between components to prove that they share a design-system abstraction. Do not test a UI automation helper against a hand-written fixture that was created to match the helper.

A browser layout measurement is appropriate only when geometry drives the behavior under test—for example, keeping an anchored menu inside the viewport, detecting clipped text, or preventing a state change from shifting a control. Assert only that invariant, not unrelated styling.

If an interaction test also needs visual review, keep visual assertions out of the behavior test. Use a deliberately maintained visual-regression artifact or manual review instead; visual changes should not silently become default-suite compatibility promises.

## Server-rendered HTML tests

Prefer server-rendered tests for markup and response contracts. Assert durable semantics and server/client protocols:

- roles, accessible names, states, form actions, and destinations;
- Turbo Stream actions and targets;
- state-dependent presence or absence;
- escaping, sanitization, and content safety;
- stable live-node and transplant contracts;
- meaningful rendering branches.

Avoid pinning entire class lists, incidental nesting, SVG paths, exact markup ordering, former class-name absence, or duplicated design-system classes unless that detail is itself a functional protocol. A single test should not serve as a serialized snapshot of a large HTML fragment.

## Client logic tests

Use fast unit tests for coherent calculations and state transitions such as completion parsing, prompt history, scroll calculations, and terminal input mapping. Do not extract unnatural public helpers solely to make every UI line unit-testable.

## Review checklist

Before adding or expanding a UI test, answer:

1. What user-visible regression does this catch?
2. Why can a cheaper server or unit test not catch it?
3. Does the assertion describe behavior, or merely today's appearance and markup?
4. Will a legitimate redesign require changing this test?
5. Is the same contract already covered at another layer?

If the test primarily protects appearance, omit it from the default behavior suite and arrange explicit visual review instead.
