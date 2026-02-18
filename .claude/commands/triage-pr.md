Triage the following pull request from an external contributor.

$ARGUMENTS

## Steps

1. Use `mcp__github__get_pull_request` to get the PR details (extract the PR number and repo from the arguments above).
2. Use `mcp__github__get_pull_request_files` to see what files are changed and how many lines are modified.
3. Evaluate the PR against the rules below, in order. Stop at the first matching rule.

---

## Rule 1: Spam detection

Use `mcp__github__list_pull_requests` to check the author's recent activity. **Close without further evaluation** if ANY of these apply:
- Author has 3+ PRs opened in the last 24 hours with none merged
- Author has multiple PRs targeting the same issue
- PR body is AI-generated boilerplate with no project-specific content (e.g., generic "I improved the code quality" with no specifics)
- Changes are clearly unrelated to the project (self-promotion, spam links, random files)

If closing for spam, comment:
"Closing this PR. [Brief reason — e.g., 'Multiple PRs opened in rapid succession' or 'Changes are unrelated to this project']. If this was a mistake, please open a single focused PR with a clear description."

## Rule 2: Auto-close as low-quality

Close if ANY of these apply:
- Empty PR description (no explanation of what or why)
- Trivial changes that add no value (whitespace-only, random comment additions, reformatting without functional changes)
- PR modifies only CI/workflow files without prior discussion in an issue

If closing, comment:
"Closing this PR. [Specific reason]. To contribute, please open an issue first to discuss the proposed change."

## Rule 3: Demo video requirement

Determine if the PR is **exempt** from demo video. A PR is exempt if ANY of these are true:
- Total lines changed (additions + deletions) is under 10 AND changes are typo fixes, small doc edits, or comment-only
- Changes are test-only (only adds or modifies test files)
- Changes are backend/API-only with no UI impact (no frontend file changes)
- Pure refactoring (under 100 lines changed) that maintains existing behavior with no new features

**If the PR is not exempt and does not include a demo video** (a link to a video, gif, Loom, or screen recording in the PR description), close it with this comment:
"PRs with UI or functional changes require a demo video (screen recording, gif, or Loom link) showing the change in action. Please reopen this PR with a demo attached to the description. Test-only, backend-only, and small doc/typo fixes are exempt."

**If the PR is a bounty claim** (title or description contains "bounty", or has a bounty-related label) and missing a demo video, close with:
"Bounty claims require a demo video showing the feature or fix working. Please reopen with a video, gif, or screen recording attached to the PR description."

## Rule 4: LLM provider changes

If the PR adds or modifies an LLM provider (changes files under `backend/src/routes/proxy/`, `backend/src/types/llm-providers/`, `backend/src/routes/proxy/adapterV2/`, or `backend/src/clients/`), comment noting the PR should be reviewed against `docs/pages/platform-adding-llm-providers.md`:
https://github.com/archestra-ai/archestra/blob/main/docs/pages/platform-adding-llm-providers.md

This is informational only — do not close the PR for this reason. Continue evaluating remaining rules.

## Rule 5: Issue reference check

If the PR does not reference an issue (no "Fixes #", "Closes #", "Resolves #", or "#NNN" in the title or description), comment:
"Please link this PR to a related issue. If there is no existing issue, please create one describing the problem or feature before this PR can be reviewed."

Do not close the PR for this reason, but do NOT add the `ready for review` label. Apply the `needs more info` label instead along with the appropriate type label (`bug`, `enhancement`, or `documentation`).

## Rule 6: Valid PR

If the PR passes all rules above:
- Apply the appropriate type label: `bug`, `enhancement`, or `documentation`
- Apply the `ready for review` label
- **Do not comment.** Valid PRs are labeled silently.

---

## Tone

- Professional and direct. No exclamation marks. No "Thanks for contributing!" or "Great work!" filler.
- When commenting on problems, be specific about what is wrong and what the contributor should do.

## Tools to use

- `mcp__github__get_pull_request` — Get PR details
- `mcp__github__list_pull_requests` — Check author's recent PRs for spam detection
- `mcp__github__search_issues` — Search for related issues
- `mcp__github__add_issue_comment` — Comment (only when there is a problem or informational note)
- `mcp__github__update_pull_request` — Add labels, close PRs
- `mcp__github__get_pull_request_diff` — View PR diff
- `mcp__github__get_pull_request_files` — View changed files
- `mcp__github__create_pull_request_review` — Leave a review comment
