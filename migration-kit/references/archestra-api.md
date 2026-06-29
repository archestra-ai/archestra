# Archestra API quick reference

Base URL `http://localhost:9000` (or the user's instance). Auth: `Authorization: <api-key>` (no Bearer).
Live schema: `GET /openapi.json`. All routes below are verified against the backend.

The `archestra_client.py` module wraps every call with typed payloads and raises
`ArchestraApiError` (carrying the full response body) on any non-2xx — no silent failures.

## Entities & create endpoints
| Entity | Create | List (for idempotency) |
|---|---|---|
| Agent | `POST /api/agents` | `GET /api/agents?name=&scope=` |
| Skill | `POST /api/skills` | `GET /api/skills?search=` |
| MCP catalog item | `POST /api/internal_mcp_catalog` | `GET /api/internal_mcp_catalog` (filter client-side by name) |
| MCP install | `POST /api/mcp_server` | `GET /api/mcp_server?catalogId=` |
| LLM provider key | `POST /api/llm-provider-api-keys` | `GET /api/llm-provider-api-keys?search=&provider=` |
| Tool-invocation policy | `POST /api/autonomy-policies/tool-invocation` | `GET /api/tools?search=` (resolve toolId) |
| Lifecycle hook | `POST /api/hooks` | `GET /api/hooks?agentId=` (filter client-side by event+fileName) |
| Enable skill tools | `POST /api/skills/enable-defaults` (idempotent) | — |

## Payload notes (what the builder relies on)
- **Agent** (`agentType:"agent"`): `name`, `scope`, optional `systemPrompt`, `description`, `teams[]`
  for `scope:"team"`. Leave
  `modelId`/`llmApiKeyId` BOTH unset → the agent inherits the org default model. Setting only one is a 400.
- **Skill**: `content` (the SKILL.md markdown — its frontmatter supplies name+description), `scope`,
  optional `files[]` of `{path, content, encoding}`. `path` must be relative and contain no `..`.
  For `scope:"team"`, `teamIds[]` is required and must contain at least one existing team id.
- **MCP catalog**: `serverType` `local` (→ `localConfig{command, arguments[], environment[]}`) or
  `remote` (→ top-level `serverUrl`). For `scope:"team"`, send `teams[]`. A redacted env value becomes an `environment` entry with
  `type:"secret", promptOnInstallation:true` and no value — the user supplies it at install.
- **MCP install**: `name` and `catalogId` are both required; resolve the catalog id by catalog name
  at apply time and reuse that same name for the install.
  Installing a `local` server spins a K8s pod in the KinD cluster — only do it when the user opts in.
  For `scope:"team"`, send `teamId`. Send `agentIds[]` to attach discovered tools to migrated agents.
- **LLM key**: `provider`, `scope`, `apiKey` (user-supplied; never read from the user's files silently),
  optional `baseUrl`, optional `isPrimary`, and `teamId` for `scope:"team"`.
- **Tool policy**: `toolId` (must be a tool that exists in Archestra), `conditions[]` of
  `{key, operator, value}` (operators incl. `regex`), `action` (`block_always` etc.), optional `reason`.
  Policies only enforce when the org `globalToolPolicy` is `restrictive` — surface that to the user.
- **Lifecycle hook**: `agentId` (the agent it attaches to), `event`
  (`session_start`|`pre_tool_use`|`post_tool_use` — Claude's other events have no equivalent),
  `fileName` (a plain basename matching `^[A-Za-z0-9][A-Za-z0-9._-]*\.(py|sh)$`, ≤255), `content`
  (the script body, 1..65536 chars), `requirements[]` (pip deps for a `.py` hook, run via
  `uv run --with`; **empty for `.sh`** — bash hooks have no dependency mechanism; ≤20, each a single
  line ≤200 chars), `enabled` (defaults true). The hook receives a Claude-compatible JSON payload on
  stdin (`hook_event_name`, `tool_name`, `tool_input`, `tool_response`, …) and signals via exit code
  (`2` = block with stderr as the reason; `0` = proceed with stdout injected; errors/timeout fail open).

## Idempotency contract
`apply.py` checks existence by (name, scope) before each create and records `skipped(exists)` on a hit,
so re-running a plan is safe. Catalog/mcp_server have no name filter, so they are listed and matched
client-side. Hooks are matched by `(agentId, event, fileName)` — the server's unique key — against
`GET /api/hooks?agentId=`.
