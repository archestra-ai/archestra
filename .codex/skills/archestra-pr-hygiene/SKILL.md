---
name: archestra-pr-hygiene
description: Use when opening or updating an Archestra pull request to write an accurate conventional title and a practical, evidence-based description.
---

# Archestra pull request hygiene

Review the final diff and commit history before writing PR metadata. Describe the change that is actually present, not the work session that produced it.

## Title

Follow `.github/commitlint.config.js`: use a conventional-commit title such as `feat(scope): add execution credentials`, choose one of its allowed types, omit a trailing period, and stay within its 100-character limit. Keep the title focused on the PR's primary outcome.

## Description

Keep the body concise and concrete. Cover:

- the problem or user need being addressed;
- the implementation approach and important behavior changes;
- meaningful alternatives or tradeoffs, when they affected the design;
- how the change was exercised as a real workflow, including the scenario and observed result.

Do not pad the description with a list of routine commands, lint/type-check status, test counts, generic claims of quality, or a file-by-file changelog. Mention an automated check only when it validates a behavior that is otherwise difficult to explain or when its result is material to the reviewer.

Before opening or updating the PR, verify that the title and body still match the final diff and do not expose secrets, private data, or customer identifiers.
