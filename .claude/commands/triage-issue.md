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

## Response format

When commenting on the issue:

### If closing as low-quality:
Be polite but direct. Explain why the issue doesn't meet quality standards. Suggest what information would be needed to reopen. Example:
"Thanks for reporting this. I'm closing this issue because [reason]. If you can provide [missing info], please reopen with those details."

### If closing as duplicate:
"This appears to be a duplicate of #NNN. Please follow that issue for updates. If your case is different, please reopen with details about how it differs."

### If valid:
Add labels only. Do not comment unless there's something specific to clarify.

## Tools to use
- `mcp__github__get_issue` - Get issue details
- `mcp__github__search_issues` - Search for duplicates
- `mcp__github__list_issues` - List recent issues if needed
- `mcp__github__create_issue_comment` - Add comments
- `mcp__github__update_issue` - Add labels, close issues
- `mcp__github__get_issue_comments` - Check existing comments
