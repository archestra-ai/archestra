# Agent Template Catalog

The Agent Template Catalog creates curated agents from a fixed manifest. Each template defines the agent name, description, system prompt, labels, and tool list. The platform resolves provisioning requirements first, then creates the agent and applies tool assignments in one flow.

## Flow

1. Open **Agents** and select **From Template**.
2. Browse the catalog or open **Preview** to inspect categories, system prompt, tools, and labels.
3. Select **Use Template**.
4. The platform requests template requirements before creating anything.
5. If a required catalog needs user input, the create dialog shows a config form first.
6. The agent is created with the template-defined config and `scope: "personal"`.
7. Missing MCP servers are provisioned next:
   - auto-install catalogs are installed directly
   - catalogs that need input use the existing install orchestrator flow
8. Tool assignments are sent in bulk with the per-assignment credential mode.
9. If bulk assignment fails, the newly created agent is deleted.
10. The user is redirected to `/chat` when provisioning completes, or back to `/agents` when follow-up is still required.

## Templates

The manifest includes three templates:

| Template | Purpose | Tool profile |
|----------|---------|--------------|
| `ops-engineer` | Investigate agents, MCP servers, and limits | Built-in tools only |
| `code-reviewer` | Review repository context, issues, and send follow-up messages | GitHub, Slack, knowledge lookup |
| `general-purpose` | Start with a clean assistant | No tools |

## Credential Resolution

Credential mode is derived per tool assignment.

| Catalog type | Mode |
|--------------|------|
| Built-in Archestra catalog | omitted |
| Third-party catalog with user-supplied credentials | `static` |
| Third-party catalog without user input | `dynamic` |
| Enterprise-managed catalog | `enterprise_managed` |

For non-static assignments, the bulk-assign payload also includes `resolveAtCallTime: true`.

## API

- `GET /api/agent_templates`
- `GET /api/agent_templates/:id/requirements`

The requirements response returns:

- `agentConfig`: the exact create-agent payload
- `toolAssignments`: resolved tool IDs plus credential metadata
- `missingCatalogs`: catalogs that still need installation or user input

Example:

```json
{
  "templateId": "code-reviewer",
  "agentConfig": {
    "name": "Code Reviewer",
    "description": "Reviews repositories and issues, summarizes risks, and can notify collaborators in Slack.",
    "systemPrompt": "...",
    "llmModel": null,
    "labels": [
      { "key": "template", "value": "code-reviewer" },
      { "key": "persona", "value": "review" }
    ],
    "scope": "personal",
    "teams": []
  },
  "toolAssignments": [
    {
      "toolId": "tool-github",
      "catalogId": "github-catalog",
      "credentialResolutionMode": "static",
      "requiresUserConfig": true
    }
  ],
  "missingCatalogs": [
    {
      "catalogId": "github-catalog",
      "catalogName": "github",
      "serverType": "remote",
      "requiresOauth": false,
      "userConfigFields": [
        {
          "key": "token",
          "type": "string",
          "title": "Token",
          "description": "API token",
          "required": true
        }
      ],
      "environmentFields": [
        {
          "key": "GITHUB_HOST",
          "type": "plain_text",
          "promptOnInstallation": true,
          "description": "Host override"
        }
      ],
      "canAutoInstall": false
    }
  ]
}
```
