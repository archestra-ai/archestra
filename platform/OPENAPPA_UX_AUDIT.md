# OpenAPPA setup and usage UX review

Reviewed the local OpenAPPA page in Chrome on 2026-09-22. The checks used unsaved drafts only. No policy revision, GitHub source, battery, or plugin was changed through the UI. The deployment switch and legacy guardrails migration are outside this follow-up.

## Draft loss on in-app navigation

Before this change, an unsaved policy draft vanished after clicking a sidebar link. The editor guarded page unloads, but Next.js client-side navigation did not unload the page. The editor now uses the shared in-app navigation guard. **Keep editing** preserves the draft; **Discard changes** follows the link.

## Setup dialogs discarded edits silently

Before this change, entering a GitHub repository and pressing **Cancel** closed the dialog immediately. The GitHub source and battery upload dialogs now use the shared dirty-form guard. The GitHub form also marks authentication and sync-frequency changes as dirty.

## Validation feedback did not gate save

The backend rejects invalid policies, but **Save & apply** stayed enabled after a failed validation. The error was below the tall editor. A failed validation now appears above the editor and disables save until the draft changes. Validation warnings remain separate from errors.

## First-run paths lacked context

The policy editor now links to its guide. The empty Batteries panel links to MCP Registry. The upload dialog links to battery documentation and previews selected file paths. The page links to the separate Claude Code plugin setup.

## Verification

Component tests cover the draft guards, failed validation, and registry link. A live Chrome check confirmed that sidebar navigation asks before discarding a policy draft. The full frontend suite on the original base had two failures in unrelated settings tests; the branch was then rebased onto `main` and the focused OpenAPPA tests passed. End-to-end enforcement and battery execution were outside this UI pass.
