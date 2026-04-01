Analyze this MCP tool and determine security policies.

The primary security goal is to PREVENT LEAKING SENSITIVE DATA FROM INTERNAL SYSTEMS TO EXTERNAL SERVICES. Internal systems (Jira, GitHub, databases, etc.) contain sensitive organizational data. External-facing tools (browsers, web scrapers, email senders, etc.) can transmit data outside the organization. Policies must ensure sensitive internal data never flows outward through external tools.

Tool: {{tool.name}}
Description: {{tool.description}}
MCP Server: {{mcpServerName}}
Parameters: {{tool.parameters}}
Annotations: {{tool.annotations}}

Determine two policies:

1. toolInvocationAction — Controls WHEN the tool may be invoked based on whether the conversation context contains sensitive data.
   - "allow_when_context_is_sensitive": The tool is safe to invoke even when the context contains sensitive data. Use for tools that CANNOT leak context externally — they only read from or write to internal systems. Examples: internal API queries, database reads, self-hosted service integrations.
   - "block_when_context_is_sensitive": The tool must be BLOCKED when the context contains sensitive data because it could transmit that data externally. Use for tools that send data to external services or the open internet. Examples: browsers, web search, email, external APIs, code execution sandboxes.
   - "block_always": The tool must NEVER be invoked automatically. Use for destructive operations. ANY tool whose name contains "delete", "remove", or "destroy" MUST use this action.

2. trustedDataAction — Controls HOW the tool's returned results are treated, based on whether they could contain sensitive or adversarial content.
   - "mark_as_safe": Results are fully trusted. Use only for internal dev/config tools returning non-sensitive metadata (e.g., list-endpoints, get-config, health checks).
   - "mark_as_sensitive": Results contain sensitive data that must be protected from leaking to external tools. Use for ANY tool that reads from internal self-hosted systems (Jira, GitHub, GitLab, Confluence, databases, internal APIs, file systems) — their results contain organizational data.
   - "block_always": Results are too dangerous to surface. Rarely used.

CRITICAL RULES:
- Delete/remove/destroy tools → ALWAYS block_always invocation, regardless of other factors.
- Internal self-hosted tools (Jira, GitHub, GitLab, Confluence, databases, internal wikis) → allow_when_context_is_sensitive (safe to call) + mark_as_sensitive (results contain org data that must not leak).
- External-facing tools (browsers, Playwright, web search, email, external APIs) → block_when_context_is_sensitive (could leak context) + mark_as_safe (their results are controlled by us, not sensitive org data).

Examples:
- jira__get_issue: invocation="allow_when_context_is_sensitive", result="mark_as_sensitive"
- github__list_pull_requests: invocation="allow_when_context_is_sensitive", result="mark_as_sensitive"
- database__query: invocation="allow_when_context_is_sensitive", result="mark_as_sensitive"
- confluence__get_page: invocation="allow_when_context_is_sensitive", result="mark_as_sensitive"
- playwright__navigate: invocation="block_when_context_is_sensitive", result="mark_as_safe"
- playwright__screenshot: invocation="block_when_context_is_sensitive", result="mark_as_safe"
- jira__delete_issue: invocation="block_always", result="mark_as_safe"
- github__delete_repo: invocation="block_always", result="mark_as_safe"
- file_write: invocation="block_always", result="mark_as_safe"
