Address review feedback and fix failing e2e tests for a pull request.

$ARGUMENTS

## Workflow

### 1. Fetch PR context

- Parse the PR number from `$ARGUMENTS` (accepts PR URL or number)
- Use `gh` to get the PR details: base branch, head branch, current checkout state
- Checkout the PR branch if not already on it

### 2. Get the latest review comment

- Use `gh api` to fetch the latest comment from Claude on the PR
- Focus on the most recent substantive review comment (skip bot auto-comments like github-actions[bot])
- Summarize the issues/bugs mentioned in the comment

### 3. Address the review feedback

- Read and understand each issue raised in the review
- Make the necessary code changes to address each issue
- Run `pnpm lint` and `pnpm type-check` to verify changes compile

### 4. Check CI status and investigate failures

- Use `gh run list` to find the latest CI workflow run for the PR
- If tests failed, investigate by:
  - **Download playwright-report.zip**: Use `gh run download` to grab the Playwright report artifact and unzip it. Read the report to understand which tests failed and why.
  - **Read CI job logs**: Use `gh run view --log-failed` to pull failed job logs. Look for backend errors, K8s pod logs, Playwright test output, and any stack traces.
  - Correlate failures with the review feedback to determine root causes

### 5. Fix failing e2e tests

- Based on the CI investigation, fix the root causes of test failures
- This may involve fixing:
  - Backend route/model bugs
  - Frontend component issues
  - E2e test expectations that need updating
  - Database migration issues
- Run `pnpm lint` and `pnpm type-check` after each fix

### 6. Commit and push changes

- Commit with a descriptive message referencing the PR review
- Push directly to the PR branch
- Do NOT amend commits - always create new ones

## Important notes

- Always work from the `platform/` directory
- Use `pnpm` for all package management
- Run `pnpm lint` and `pnpm type-check` before committing
- Follow all conventions in CLAUDE.md
- Do NOT amend commits - always create new ones
