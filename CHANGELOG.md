# Changelog

## 0.5.0

- Edit original review comments, including comments in resolved threads.
- Edit reviewer-authored follow-up replies while keeping Codex replies immutable.
- Preserve the thread status and conversation when a comment is edited.

## 0.4.1

- Fix Codex App Server startup by keeping workspace parameters on the stable API surface.

## 0.4.0

- Mark changed files as Viewed or Unviewed from the review tree.
- Show per-file Viewed status and reviewed-file progress in the Changes group.

## 0.3.0

- Add native VS Code commenting ranges on changed lines so a dragged selection can be reviewed from the gutter `+` button.

## 0.2.0

- Show Codex responses as replies under their matching local review comments.
- Allow reviewer follow-up replies to continue in the same Codex session.
- Keep outdated comment conversations visible as file-level threads.

## 0.1.0

- Create a local Virtual PR from a Git base ref.
- Review changed files with the working-tree file on the navigable side of the diff.
- Add persistent local review comments and send unresolved feedback to Codex.
- Refresh changes after Codex edits and approve the review locally.
