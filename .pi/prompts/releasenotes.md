---
description: Draft release notes for a commit range
argument-hint: "[commit range or change description]"
---
Draft release notes for this requested range or set of changes: `${ARGUMENTS:-the changes on main since the most recent release on the stable channel}`.

If no range or change description was provided, figure out what the most recent release was on the `stable` channel and analyze all commits on `main` since then. If a range or change description was provided, operate on those changes instead.

Write release notes that cover the complete set of user-impacting changes in scope. Structure them in this order:

1. Features
2. Improvements and bug fixes

Write each note through the eyes of the user: explain what changed and how it affects them. Omit changes that have no meaningful user impact. Some changes may only need a one-line note; others may be small in code but significant for users and deserve a more extensive explanation.

First write out the full release notes. Only after the release notes are written, identify notes that would benefit from media. For each note where a video would be useful, create a new Atelier workspace and prompt it to make a video for that feature. Do the same for notes where a screenshot would be useful.
