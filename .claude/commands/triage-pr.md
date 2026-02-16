Triage the following pull request from an external contributor.

$ARGUMENTS

## Steps

1. Use `mcp__github__get_pull_request` to get the PR details (extract the PR number from PR_NUMBER above).
2. Use `mcp__github__get_pull_request_files` to see what files are changed.
3. Evaluate the PR against the rules below.

### Auto-close as low-quality if ANY of these apply:
- Empty or boilerplate PR description (no explanation of what/why)
- Changes are clearly unrelated to the project (spam, self-promotion, etc.)
- Trivial changes that add no value (whitespace-only, random comment additions)
- PR modifies only CI/workflow files without prior discussion

### Bounty claim PRs:
If the PR title or description contains "bounty" or the PR has a bounty-related label (e.g. "Bounty claim"), it MUST include a demo video (a link to a video, gif, or screen recording) showcasing the feature or fix. If no demo video is present, close the PR with a comment explaining:
"This PR is a bounty claim but doesn't include a demo video. All bounty claims must include a video/gif/screen recording demonstrating the feature or fix. Please reopen with a demo attached."

### LLM provider PRs:
If the PR adds or modifies an LLM provider (e.g. changes files under `backend/src/routes/proxy/`, `backend/src/types/llm-providers/`, `backend/src/routes/proxy/adapterV2/`, or `backend/src/clients/`), leave a review comment noting that the PR should be reviewed against the standards defined in `docs/pages/platform-adding-llm-providers.md`. Include a link: https://github.com/archestra-ai/archestra/blob/main/docs/pages/platform-adding-llm-providers.md

### Check for related issues:
4. If the PR doesn't reference an issue, comment asking the contributor to link one.

### Valid PRs:
5. If the PR is valid, apply appropriate labels:
   - `bug` - Bug fixes
   - `enhancement` - New features or improvements
   - `documentation` - Documentation changes

6. If the PR is valid and high-quality, leave a brief welcoming comment.

## IMPORTANT: You MUST always leave a comment

**Every PR MUST receive a comment via `mcp__github__add_issue_comment` before any other action (labeling, closing, etc.).** Never close or label a PR without commenting first.

### If closing as low-quality:
You MUST use `mcp__github__add_issue_comment` to post a comment BEFORE closing. Be polite but direct. Example:
"Thanks for your interest in contributing! I'm closing this PR because [reason]. If you'd like to contribute, please open an issue first to discuss the change."

### If closing as bounty claim without video:
You MUST use `mcp__github__add_issue_comment` to post a comment BEFORE closing. Example:
"This PR is a bounty claim but doesn't include a demo video. All bounty claims must include a video/gif/screen recording demonstrating the feature or fix. Please reopen with a demo attached."

### If valid but missing issue reference:
You MUST use `mcp__github__add_issue_comment` to post a comment. Example:
"Thanks for the PR! Could you please link this to a related issue? If there isn't one, please create an issue first describing the problem or feature."

### If valid:
You MUST use `mcp__github__add_issue_comment` to acknowledge the PR. Example:
"Thanks for the contribution! I've labeled this PR for the team to review."

## Tools to use
- `mcp__github__get_pull_request` - Get PR details
- `mcp__github__list_pull_requests` - List recent PRs if needed
- `mcp__github__search_issues` - Search for related issues
- `mcp__github__create_pull_request_review` - Leave a review
- `mcp__github__add_issue_comment` - ALWAYS use this to comment before any other action
- `mcp__github__update_pull_request` - Add labels, close PRs (AFTER commenting)
- `mcp__github__get_pull_request_diff` - View PR diff
- `mcp__github__get_pull_request_files` - View changed files
