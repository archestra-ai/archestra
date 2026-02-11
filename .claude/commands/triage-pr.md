Triage the following pull request from an external contributor.

$ARGUMENTS

## Steps

1. Use `mcp__github__get_pull_request` to get the PR details (extract the PR number from PR_NUMBER above).
2. Evaluate the PR quality:

### Auto-close as low-quality if ANY of these apply:
- Empty or boilerplate PR description (no explanation of what/why)
- Changes are clearly unrelated to the project (spam, self-promotion, etc.)
- Trivial changes that add no value (whitespace-only, random comment additions)
- PR modifies only CI/workflow files without prior discussion

### Check for related issues:
3. If the PR doesn't reference an issue, comment asking the contributor to link one.

### Valid PRs:
4. If the PR is valid, apply appropriate labels:
   - `bug` - Bug fixes
   - `enhancement` - New features or improvements
   - `documentation` - Documentation changes

5. If the PR is valid and high-quality, leave a brief welcoming comment.

## Response format

### If closing as low-quality:
Be polite but direct. Example:
"Thanks for your interest in contributing! I'm closing this PR because [reason]. If you'd like to contribute, please open an issue first to discuss the change."

### If valid but missing issue reference:
"Thanks for the PR! Could you please link this to a related issue? If there isn't one, please create an issue first describing the problem or feature."

## Tools to use
- `mcp__github__get_pull_request` - Get PR details
- `mcp__github__list_pull_requests` - List recent PRs if needed
- `mcp__github__search_issues` - Search for related issues
- `mcp__github__create_pull_request_review` - Leave a review
- `mcp__github__create_issue_comment` - Add comments
- `mcp__github__update_pull_request` - Add labels, close PRs
- `mcp__github__get_pull_request_diff` - View PR diff
- `mcp__github__get_pull_request_files` - View changed files
