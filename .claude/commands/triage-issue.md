Triage the following GitHub issue and determine if it is valid, a duplicate, or low-quality.

$ARGUMENTS

## Steps

1. Use `mcp__github__get_issue` to get the full issue details (extract the issue number from ISSUE_NUMBER above).
2. Evaluate the issue quality based on these criteria:

### Auto-close as low-quality if ANY of these apply:
- No reproduction steps for a bug report
- Purely a question that belongs in Discussions, not Issues (e.g. "How do I configure X?")
- Feature request with no concrete use case or justification
- Issue body is empty or contains only a title repetition
- Obvious spam or off-topic content
- The issue is clearly a misconfiguration or user error that's answered by existing documentation

### Check for duplicates:
3. Use `mcp__github__search_issues` with relevant keywords from the issue title and body to find potential duplicates.
4. If duplicates exist, label as "duplicate", comment linking to the original, and close.

### Valid issues:
5. If the issue is valid, apply appropriate labels:
   - `bug` - Confirmed or likely bug reports with reproduction steps
   - `enhancement` - Well-described feature requests with use cases
   - `documentation` - Documentation improvements or corrections
   - `question` - Legitimate technical questions (if complex enough to warrant an issue)

## IMPORTANT: You MUST always leave a comment

**Every issue MUST receive a comment via `mcp__github__add_issue_comment` before any other action (labeling, closing, etc.).** Never close or label an issue without commenting first.

### If closing as low-quality:
You MUST use `mcp__github__add_issue_comment` to post a comment BEFORE closing. Be polite but direct. Explain why the issue doesn't meet quality standards. Suggest what information would be needed to reopen. Example:
"Thanks for reporting this. I'm closing this issue because [reason]. If you can provide [missing info], please feel free to reopen with those details."

### If closing as duplicate:
You MUST use `mcp__github__add_issue_comment` to post a comment BEFORE closing. Example:
"This appears to be a duplicate of #NNN. Please follow that issue for updates. If your case is different, please reopen with details about how it differs."

### If valid:
You MUST use `mcp__github__add_issue_comment` to acknowledge the issue. Example:
"Thanks for reporting this! I've labeled this issue for the team to review."

## Tools to use
- `mcp__github__get_issue` - Get issue details
- `mcp__github__search_issues` - Search for duplicates
- `mcp__github__list_issues` - List recent issues if needed
- `mcp__github__add_issue_comment` - ALWAYS use this to comment before any other action
- `mcp__github__update_issue` - Add labels, close issues (AFTER commenting)
- `mcp__github__get_issue_comments` - Check existing comments
