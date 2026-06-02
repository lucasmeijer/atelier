# TODO: Diffs.com-based Git Review Tool

## Goal

Build an Atelier review UI powered by `@pierre/diffs` / diffs.com for reviewing workspace commits before merge.

The review tool should show only commits that are **unpublished** relative to the target branch.

## Definitions

### Target branch

The branch the workspace changes would eventually merge into, usually:

```text
main
```

or the managed repo's configured default branch.

### Unpublished commits

A commit is unpublished if it is reachable from the workspace/review head but **not reachable from the target branch**.

Equivalent Git idea:

```bash
git rev-list <target-branch>..<workspace-head>
```

or:

```bash
git log <target-branch>..<workspace-head>
```

This gives the commits that exist on the workspace side but are not in the target branch.

## Default range

By default, the review range is:

```text
all unpublished commits
```

Conceptually:

```bash
base = merge-base(target_branch, workspace_head)
end = workspace_head
range = base..end
```

The UI should render the diff for that entire contiguous range.

## Range selection

The user should be able to change the start and end commit within the unpublished commit list.

Requirements:

- Selecting a single commit must work.
- Selecting a contiguous range of commits must work.
- It must be impossible to create holes in the range.
- The selected range is always contiguous in commit order.
- The selected commits must all be unpublished relative to the target branch.

Examples:

```text
[ A, B, C, D ] unpublished commits
```

Allowed:

```text
A..D  all commits
B..D
A..C
B..C
C only
```

Not allowed:

```text
A + C without B
A + D without B/C
```

## UI idea

For each managed repo modified by a workspace:

- Show repo name.
- Show target branch.
- Show unpublished commit list.
- Provide start/end selectors.
- Render selected range with diffs.com/Pierre.

Possible controls:

```text
Repo: webshop-frontend
Target: main
Unpublished: 4 commits

Start: [feat: useTheme hook        v]
End:   [feat: settings toggle      v]
```

Or a visual commit strip:

```text
main ──●──●──○──○──○──○ workspace HEAD
            ^ selected range ^
```

## Diff rendering

Use `@pierre/diffs` for the actual file diff rendering.

For selected range:

```bash
git diff <start-parent>..<end>
```

For single commit:

```bash
git show <commit>
```

Implementation can either:

1. Generate unified patches and parse with `parsePatchFiles`, or
2. Load old/new file contents and use `parseDiffFromFile` / `FileDiff`.

Patch-based rendering is likely simplest first.

## Multi-repo support

A workspace can modify multiple managed repos.

The review page should show one review section per repo:

```text
webshop-frontend
  range selector
  diffs

design-tokens
  range selector
  diffs
```

Each repo has its own target branch, unpublished commit list, and selected range.

## Empty / edge states

Handle:

- No unpublished commits.
- Workspace has uncommitted changes.
- Workspace head is behind target branch.
- Workspace diverged from target branch.
- Target branch changed since workspace was created.
- Merge-base cannot be found.

For first version, if the graph is complicated, show a clear warning and still offer a best-effort unpublished range using:

```bash
git rev-list <target>..<head>
```

## Merge relationship

The review range should be the same range Atelier will attempt to merge by default.

Changing the displayed review range should not necessarily change the merge target unless we explicitly add that behavior later.

Initial assumption:

- Review UI can inspect subranges.
- Merge still merges all unpublished commits by default.

Open question:

- Should the user be allowed to merge only the selected range?

## Security / correctness

Do not trust client-side range selection.

Server should validate:

- selected start/end are unpublished commits
- selected range is contiguous
- commits belong to the expected managed repo/workspace ref
- target branch is the expected branch

## Open questions

- Should the default base be `merge-base(target, head)` or the workspace recorded clone `baseSha`?
- How should review behave if target branch advanced after workspace creation?
- Should range selection be per repo or synchronized across repos somehow?
- Should commit messages be rendered alongside file diffs?
- Should comments/annotations be stored against commit+file+line?
