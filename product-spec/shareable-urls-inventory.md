# Shareable URLs — per-dialog inventory

Companion to [shareable-dialog-urls.md](./shareable-dialog-urls.md) ([#6582](https://github.com/archestra-ai/archestra/issues/6582)). Snapshot of what's URL-shareable today, at **per-dialog** granularity — a page can have a dedicated `[id]` route and still hide non-shareable edit/detail dialogs behind local state (e.g. the knowledge connector edit dialog). Paths are relative to `platform/frontend/src/` (`app/` prefix omitted except for `components/`). Line numbers are a snapshot and will drift.

## Mechanisms in use

1. **Dedicated `[id]` route** — full page per entity.
2. **Query-param dialog deep link** — `?edit=<id>` etc. Canonical hook: `lib/hooks/use-agent-dialog-url-param.ts` (param persists while the dialog is open, removed on close). Bespoke variants: skills (`skills/_parts/editor-url.ts`), environments (`mcp/registry/_parts/environment-edit-link.ts`), tool-guardrails policy editor (`?toolId=`, persists while open), identity providers (inline, one-way — see notes). MCP catalog `?edit=<catalogId>` is now a legacy redirect to `/mcp/registry/[id]/edit` (`mcp/registry/_parts/mcp-server-card.tsx:233,251`), no longer a dialog.
3. **`useDialogs` (`lib/hooks/use-dialog.ts`)** — despite the name, plain `useState` booleans, **not** URL-backed. Anything opened through it is local-only.
4. **Local React state** — dialog opens on click, URL never changes → not shareable.

Filters/pagination are URL-synced on most list pages via `lib/hooks/use-data-table-query-params.ts`; the gaps below are about the open-object state.

Action dialogs (create, invite, delete confirm, rotate secret, install, channel setup) are intentionally excluded throughout — see the spec's non-goals.

## Already implemented

| Entity / dialog | Page | How |
|---|---|---|
| Chat conversations | `/chat` | `/chat/[conversationId]` |
| Projects (+ schedules) | `/projects` | `/projects/[id]`, `.../schedules/[triggerId]` (but the *edit dialogs* are local — see below) |
| Apps | `/apps` | `/a/[appId]`, `/a/catalog/[catalogId]` |
| Knowledge connectors | `/knowledge/connectors` | `/knowledge/connectors/[id]` (but the edit dialog is local — see below) |
| LLM logs (+ sessions) | `/llm/logs` | `/llm/logs/[id]`, `/llm/logs/session/[sessionId]` |
| MCP logs | `/mcp/logs` | `/mcp/logs/[id]` |
| MCP registry servers | `/mcp/registry` | `/mcp/registry/[id]` (+ `/edit`), `catalog/[name]` |
| MCP installation requests | `/mcp/registry/installation-requests` | `.../[id]` |
| Service accounts | `/settings/service-accounts` | `/settings/service-accounts/[id]` (sub-dialogs are action-only) |
| Agents edit/view | `/agents` | `?edit=` / `?view=` (shared hook) |
| LLM proxy edit | `/llm/proxies` | `?edit=` (shared hook) |
| MCP gateway edit | `/mcp/gateways` | `?edit=` (shared hook) |
| Environment editor | `/mcp/registry`, `/settings/environments` (same section component) | `?edit=<id\|default>` / `?create` (bespoke) |
| Skill editor | `/skills` | `?edit=<skillId>` (bespoke) |
| Tool-guardrails policy editor | `/mcp/tool-guardrails` | `?toolId=&toolName=` — open exactly while the param is present, cleared on close (`mcp/tool-guardrails/page.client.tsx:52,96-103`). Deep-link-only entry point: no in-page affordance sets it. |

## Not yet implemented

One row per dialog. Each shows/edits an identifiable object but lives in `useState` — not shareable, not refresh-safe.

| Page | Dialog | State location |
|---|---|---|
| `/knowledge/connectors` | Edit connector | `knowledge/connectors/page.client.tsx:95` |
| `/knowledge/connectors/[id]` | Edit connector | `knowledge/connectors/[id]/page.client.tsx:197` |
| `/knowledge/connectors/[id]` | Sync-run details | `knowledge/connectors/[id]/page.client.tsx:202` |
| `/knowledge/connectors/[id]` | Edit member assignment | `knowledge/connectors/_parts/connector-members-table.tsx:77` |
| `/knowledge/connectors/[id]` | Document preview | `knowledge/connectors/_parts/connector-documents-table.tsx:71` |
| `/knowledge/knowledge-bases` | Edit knowledge base | `knowledge/knowledge-bases/page.client.tsx:96` |
| `/knowledge/knowledge-bases` | Edit connector (expanded row) | `knowledge/knowledge-bases/page.client.tsx:309` |
| `/projects` | Edit project | `projects/page.client.tsx:105` |
| `/projects/[id]` | Edit project | `projects/[id]/page.client.tsx:95` |
| `/projects/[id]` | Edit schedule trigger — despite `/schedules/[triggerId]` existing | `projects/[id]/project-schedules-section.tsx:128` |
| `/apps` | App settings | `apps/_parts/app-card.tsx:186` |
| `/chat` | Edit conversation agent | `chat/page.tsx:2971` (via `useDialogs`) |
| `/llm/model-providers` | Edit provider | `llm/model-providers/page.tsx:134` |
| `/llm/models` | Edit model | `llm/models/page.tsx:111` |
| `/llm/limits` | Edit cost limit | `llm/(costs)/limits/page.tsx:218` |
| `/llm/optimization-rules` | Edit rule | `llm/(costs)/optimization-rules/page.tsx:101` |
| `/audit/logs` | Event details ([#6582](https://github.com/archestra-ai/archestra/issues/6582)) | `audit/logs/_components/audit-log-table.tsx:89` |
| `/mcp/tool-guardrails` | Tool details | `mcp/tool-guardrails/page.client.tsx:47` |
| `/mcp/registry` | Manage users (per catalog server) | `mcp/registry/_parts/InternalMCPCatalog.tsx:1113` (via `useDialogs`) |
| `/mcp/registry/new`, `/mcp/registry/[id]/edit` | Tool details (setup wizard) | `mcp/registry/_parts/catalog-setup-wizard.tsx:430` |
| `/messaging-channels/email` | Agent email settings | `messaging-channels/email/page.tsx:66` |
| `/settings/teams` | Team management | `components/teams/teams-list.tsx:49` (one-shot `?team=&section=` seed exists — see notes) |
| `/settings/roles` (EE) | Edit role | `components/roles/roles-list.ee.tsx:77` |
| `/settings/roles` (EE) | View permissions | `components/roles/roles-list.ee.tsx:78` |
| `/settings/users` | Change role (borderline action dialog) | `settings/users/page.client.tsx:233` |
| `/settings/github` | GitHub app config edit | `settings/github/page.tsx:76` |
| `/credentials/virtual-keys` | Edit virtual key | `credentials/virtual-keys/page.tsx:153` |
| `/credentials/oauth-clients` | Edit OAuth client | `credentials/oauth-clients/page.tsx:142` |

## Notes

### Partial / one-way URL sync

Deep link opens state, but in-page interaction never writes the URL back (or the param is consumed) — so the URL is not copyable after normal use.

- `/mcp/registry/[id]` — `?tab=` / `?server=` read on mount only; tab switches never write back (`mcp/registry/[id]/page.client.tsx:265,270`). Tabs are conditional: diagnostics only with ≥1 install, some local-only, credentials hidden for built-ins (`:245-252`).
- `/settings/identity-providers` (EE) — `?edit=&section=` seeds the dialog; clicking a provider in-UI sets only local state (`settings/identity-providers/_parts/identity-providers-page.ee.tsx:271,316`).
- `/settings/teams` — `?team=&section=token` consumed one-shot, stripped immediately (`components/teams/teams-list.tsx:101`).

### Non-dialog sub-state not URL-synced (lowest priority)

- `/knowledge/connectors/[id]` — run type/status/result filters + runs pagination (`page.client.tsx:200-209`); tab itself *is* URL-synced via `?tab=`.
- `/projects/[id]` — file-panel selection (`page.client.tsx:496`); right-panel tab persisted to localStorage, not URL.
- `/chat` — right-panel state (active tab, artifact/browser/apps/runs panels).
- `/settings/teams` — team-management dialog section tabs (`components/teams/team-management-dialog.tsx:120`).
- `/mcp/registry/[id]` (inspector tab) — selected-tool panel (`mcp/registry/_parts/mcp-inspector.tsx:64`).

### Pages with no object dialog (nothing to share)

`/settings/api-keys` (create/delete/reveal only — keys aren't editable), `/settings/secrets` (vault status card, no entity dialog), `/settings/account`, `/settings/agents`, `/settings/llm`, `/settings/organization`, `/settings/knowledge`, `/connection` (wizard), messaging-channel setup pages (slack/telegram/ms-teams/a2a). Earlier versions of this table wrongly listed api-keys and secrets as ❌ gaps.

### Observations

- The "not yet implemented" table has 28 dialogs across 22 pages — roughly double what the old per-entity table showed, because edit/detail dialogs on pages that *do* have `[id]` routes (connectors, projects, schedules) were invisible at entity granularity.
- Two dialogs sit behind `useDialogs`, which looks like an abstraction but is plain local state — worth migrating or renaming during the spec's phase 2 convergence.
- Most gap-list entities already have GET-by-id endpoints, so they're frontend-only changes (spec phase 3).
- The one-way sync fixes are tiny (write the param on in-page interaction / stop consuming it) and share the same generic-hook mechanism.
