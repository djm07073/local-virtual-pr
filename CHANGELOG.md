# Changelog

## 0.7.1

- Add a dedicated Reset command that immediately clears the local Virtual PR state.
- Remove review comments, Viewed files, model selection, and the Codex task link during Reset.
- Rename the existing recreate flow to Create or Replace so cancellation safely keeps the current review.

## 0.7.0

- Load the available model catalog and supported reasoning efforts from Codex App Server.
- Prompt for a model and effort whenever Send Review to AI is invoked.
- Remember the previous selection and pass it explicitly to the Codex turn.

## 0.6.0

- Save reviewer replies locally without starting Codex immediately.
- Batch pending follow-ups with all unresolved comments when Send Review to AI is invoked.
- Keep pending follow-ups queued when Codex execution fails.

## 0.5.2

- Add native checkboxes for marking changed files as Viewed.
- Fix tree-item command routing for Viewed, comment editing, source opening, Resolve, and Reopen actions.

## 0.5.1

- Fix Resolve and Reopen actions for editor comment threads.
- Add thread-title actions that map native VS Code comment threads back to stored review comments.

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
