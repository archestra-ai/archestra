Triage the following GitHub issue and determine if it is valid, needs more information, is a duplicate, or should be closed.

$ARGUMENTS

## Steps

1. Use `mcp__github__get_issue` to get the full issue details (extract the issue number and repo from the arguments above).
2. Evaluate the issue against the rules below, in order. Stop at the first matching rule.

---

## Rule 1: Auto-close as junk

Close if ANY of these apply:
- Issue body is empty
- Issue body is just the title repeated or a single vague sentence with no detail
- Obvious spam, off-topic content, or self-promotion
- AI-generated slop (generic text with no project-specific detail, e.g., "This project could benefit from improved error handling across all modules")
- Purely a question that belongs in Discussions (e.g., "How do I configure X?", "What does Y do?")

**You MUST comment before closing.** Comment:
"Closing this issue. [Specific reason — e.g., 'The issue body is empty' or 'This is a usage question better suited for GitHub Discussions']. If you believe this was closed in error, please reopen with a detailed description."

## Rule 2: Check for duplicates

Use `mcp__github__search_issues` with relevant keywords from the issue title and body to find potential duplicates among open issues.

If a duplicate exists:
- Comment: "This appears to be a duplicate of #NNN. Closing in favor of that issue. If your case is different, please reopen with details about how it differs."
- Apply the `duplicate` label
- Close the issue

## Rule 3: Needs more information

Apply this when the issue has a kernel of validity but lacks critical detail. Examples:
- Bug report without reproduction steps or environment info
- Feature request with a reasonable idea but no concrete use case or expected behavior
- Error report that describes a symptom but not the conditions that trigger it
- The issue is clearly a misconfiguration or user error but the reporter might have a legitimate underlying concern

**Do not close.** Instead:
- Apply the `needs more info` label
- Apply the appropriate type label (`bug`, `enhancement`, or `documentation`)
- Comment explaining exactly what information is needed:
  "This issue needs more detail before it can be triaged. Please provide: [specific list — e.g., 'reproduction steps, browser/OS version, and the full error message']."

## Rule 4: Valid issue

If the issue is well-described with enough detail to act on:
- Apply the appropriate type label: `bug`, `enhancement`, `documentation`, or `question`
- **Do not comment.** Valid issues are labeled silently.

---

## Hard rules

- **Never close an issue without commenting first.** No exceptions.
- **Never paraphrase the issue back to the reporter.** They wrote it — they know what it says. Only comment when adding new information or requesting specific details.
- **Do not leave "Thanks for reporting" comments on valid issues.** Only comment when there is a problem, a question, or a required action.

## Tone

- Professional and direct. No exclamation marks.
- When requesting information, be specific about what is needed and why.

## Tools to use

- `mcp__github__get_issue` — Get issue details
- `mcp__github__search_issues` — Search for duplicates
- `mcp__github__list_issues` — List recent issues if needed
- `mcp__github__add_issue_comment` — Comment (only when required by the rules above)
- `mcp__github__update_issue` — Add labels, close issues
- `mcp__github__get_issue_comments` — Check existing comments
