# Shareable URLs — per-dialog inventory

Companion to [shareable-dialog-urls.md](./shareable-dialog-urls.md) ([#6582](https://github.com/archestra-ai/archestra/issues/6582)). Snapshot of what's URL-shareable, at **per-dialog** granularity. Paths are relative to `platform/frontend/src/` (`app/` prefix omitted except for `components/`).

**Status: the spec is implemented** (branch `feat/shareable-dialog-urls`): all three phases — generic hook, convergence of bespoke implementations, and the full gap-list sweep.

## Mechanisms in use

1. **Dedicated `[id]` route** — full page per entity.
2. **Query-param dialog deep link** — `?edit=<id>` etc. Canonical hooks: `lib/hooks/use-dialog-url-param.ts`:
   - `useDialogUrlParam` — the param holds the open object's id; persists while the dialog is open, removed on close; auto-opens from a pasted URL once the caller-supplied by-id data resolves; browser back does not force-close.
   - `useDialogFlagUrlParam` — presence-only variant for dialogs on `[id]` routes (`/projects/123?edit`, no value) where the path already identifies the object.
   - The old agent-specific `use-agent-dialog-url-param.ts` and the skills bespoke copy are gone; remaining bespoke variant: environments (`mcp/registry/_parts/environment-edit-link.ts`, has `?create` semantics).
3. **`useDialogs` (`lib/hooks/use-dialog.ts`)** — plain `useState` booleans, **not** URL-backed. Still used for action dialogs.
4. **Local React state** — action dialogs only (create, invite, delete confirm, rotate secret, install, channel setup): intentionally not linkable, per the spec's non-goals.

Filters/pagination are URL-synced on most list pages via `lib/hooks/use-data-table-query-params.ts`.

## Implemented

| Entity / dialog | Page | How |
|---|---|---|
| Chat conversations | `/chat` | `/chat/[conversationId]` |
| ~~Edit conversation agent~~ | `/chat` | Not deep-linked: the dialog has been unreachable since its in-page opener was removed (Mar 2026, commit 4c737fa3f) — dead UI; consider deleting the dialog instead |
| Projects | `/projects` | `/projects/[id]`; list edit dialog `?edit=` |
| Project edit (detail page) | `/projects/[id]` | `?edit` (flag) |
| Schedule trigger edit | `/projects/[id]` | `?schedule=<triggerId>` (also `/schedules/[triggerId]` route) |
| Apps | `/apps` | `/a/[appId]`, `/a/catalog/[catalogId]`; settings dialog `?settings=<appId>` |
| Knowledge connectors | `/knowledge/connectors` | `/knowledge/connectors/[id]`; list edit dialog `?edit=` |
| Connector edit (detail page) | `/knowledge/connectors/[id]` | `?edit` (flag) |
| Sync-run details | `/knowledge/connectors/[id]` | `?run=<id>` |
| Member assignment | `/knowledge/connectors/[id]` | `?member=<accountId>` (list lookup) |
| Document preview | `/knowledge/connectors/[id]` | `?document=<id>` |
| Knowledge base edit | `/knowledge/knowledge-bases` | `?edit=`; expanded-row connector edit `?connector=<id>` |
| LLM logs (+ sessions) | `/llm/logs` | `/llm/logs/[id]`, `/llm/logs/session/[sessionId]` |
| LLM provider edit | `/llm/model-providers` | `?edit=` |
| LLM model edit | `/llm/models` | `?edit=` (list lookup) |
| Cost limit edit | `/llm/limits` | `?edit=` |
| Optimization rule edit | `/llm/optimization-rules` | `?edit=` |
| Audit log event details | `/audit/logs` | `?event=<id>` + new `GET /api/audit-logs/:id`; copy-link button in the dialog header |
| MCP logs | `/mcp/logs` | `/mcp/logs/[id]` |
| MCP registry servers | `/mcp/registry` | `/mcp/registry/[id]` (+ `/edit`), `catalog/[name]` |
| Manage users (catalog server) | `/mcp/registry` | `?manageUsers=<catalogId>` |
| MCP installation requests | `/mcp/registry/installation-requests` | `.../[id]` |
| Tool details | `/mcp/tool-guardrails` | `?view=<toolId>` |
| Tool-guardrails policy editor | `/mcp/tool-guardrails` | `?toolId=<id>` (shared hook; `toolName` param dropped — name comes from the by-id fetch) |
| Agent email settings | `/messaging-channels/email` | `?edit=<agentId>` |
| Service accounts | `/settings/service-accounts` | `/settings/service-accounts/[id]` |
| Agents edit/view | `/agents` | `?edit=` / `?view=` (shared hook) |
| LLM proxy edit | `/llm/proxies` | `?edit=` (shared hook) |
| MCP gateway edit | `/mcp/gateways` | `?edit=` (shared hook) |
| Environment editor | `/mcp/registry`, `/settings/environments` | `?edit=<id\|default>` / `?create` (bespoke) |
| Skill editor | `/skills` | `?edit=<skillId>` (shared hook; legacy `openEdit=<name>` still rewritten to `edit=<id>`) |
| Team management | `/settings/teams` | `?team=<id>` (persistent; `?section=` selects the initial section) |
| Roles edit / view permissions (EE) | `/settings/roles` | `?edit=` / `?view=` |
| Identity provider edit (EE) | `/settings/identity-providers` | `?edit=<id>` (now two-way: in-page clicks write the param) |
| GitHub app config edit | `/settings/github` | `?edit=<id>` ("new" create mode stays local) |
| Virtual key edit | `/credentials/virtual-keys` | `?edit=<id>` + new `GET /api/llm-virtual-keys/:id` |
| OAuth client edit | `/credentials/oauth-clients` | `?edit=<id>` (list lookup on merged LLM+MCP rows) |

## Intentionally not implemented

- `/mcp/registry/new`, `/mcp/registry/[id]/edit` — tool details in the setup wizard: ephemeral wizard-local state, no stable id.
- `/settings/users` — change role: action dialog (spec non-goal).
- Action dialogs everywhere (create, invite, delete confirm, rotate secret, install, channel setup) — spec non-goals.

## Notes

### Backend endpoints added for this feature

- `GET /api/audit-logs/:id` (`RouteId.GetAuditLog`, `auditLog: ["read"]`, org-scoped).
- `GET /api/llm-virtual-keys/:id` (`RouteId.GetVirtualApiKey`, `llmVirtualKey: ["read"]`, mirrors the list's non-admin visibility scoping — invisible keys 404).

### Non-dialog sub-state not URL-synced (lowest priority, unchanged)

- `/knowledge/connectors/[id]` — run type/status/result filters + runs pagination; the tab itself *is* URL-synced via `?tab=`.
- `/projects/[id]` — file-panel selection; right-panel tab persisted to localStorage, not URL.
- `/chat` — right-panel state (active tab, artifact/browser/apps/runs panels).
- `/settings/teams` — team-management dialog section tabs (beyond the initial `?section=`).
- `/mcp/registry/[id]` (inspector tab) — selected-tool panel. Tab/server selection now writes back to `?tab=`/`?server=` (fixed with this feature).

### Pages with no object dialog (nothing to share)

`/settings/api-keys` (create/delete/reveal only — keys aren't editable), `/settings/secrets` (vault status card, no entity dialog), `/settings/account`, `/settings/agents`, `/settings/llm`, `/settings/organization`, `/settings/knowledge`, `/connection` (wizard), messaging-channel setup pages (slack/telegram/ms-teams/a2a).
