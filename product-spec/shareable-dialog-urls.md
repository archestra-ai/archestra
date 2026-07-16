# Product spec: shareable URLs for detail dialogs

Issue: [#6582 — Audit log events have no shareable URL](https://github.com/archestra-ai/archestra/issues/6582)
Entity inventory (what's shareable today, what isn't): [shareable-urls-inventory.md](./shareable-urls-inventory.md)

## Problem

Opening an audit log event on `/audit/logs` shows an "Event details" modal whose state lives only in local React state (`selectedEvent`, `platform/frontend/src/app/audit/logs/_components/audit-log-table.tsx:89`). The URL never changes, so an event can't be shared, bookmarked, or reopened after refresh — while the page's *filters* already are URL-synced (same file, lines 63–104).

The same gap exists on several other pages, and the pages that do support dialog deep links do it three different ways (shared hook, bespoke copy, consume-on-close params).

## Goal

Every **object** dialog (view/edit of an entity with an id) is deep-linkable: the URL identifies the open dialog, survives refresh, works when pasted into a new tab regardless of the table's current page/filters, and is copyable while the dialog is open.

## Non-goals

- **Action** dialogs (invite user, change role, create X, rotate secret) stay non-linkable — the app deliberately treats those as one-shot triggers with consumed params (e.g. `/agents?create=true`, `/settings/teams?team=`).
- No change to pages that already use dedicated `[id]` routes (chat, projects, LLM/MCP logs, etc.).
- No new sharing infrastructure (short links, permission changes): a link is just a URL; the viewer needs the same RBAC permission they'd need to see the data anyway.

## UX behavior (uniform contract)

1. Opening a detail dialog sets `?<param>=<id>` on the current URL (`router.replace`, keeping existing filter params); closing removes it.
2. The param **persists while the dialog is open** (skills-editor semantics, `platform/frontend/src/app/skills/page.client.tsx:118-122`) — copyable at any moment. No consume-on-open.
3. Visiting a URL with the param auto-opens the dialog, **fetching the object by id** — the link works even if the object isn't in the currently loaded/filtered table page.
4. Browser back removing the param does not force-close an already-open dialog (existing semantics of `useAgentDialogUrlParam`).
5. Param naming: `?view=<id>` / `?edit=<id>` per existing convention; audit logs use `?event=<id>` (read-only detail).
6. Invalid/inaccessible id: the dialog doesn't open; surface the standard error toast/state from the fetch hook.

## Mechanism

Generalize `platform/frontend/src/lib/hooks/use-agent-dialog-url-param.ts` — it already implements semantics 1, 2, 4 and has tests, but is hard-wired to agents (`useProfile`, `AgentData`). Extract a type-agnostic `useDialogUrlParam` where the caller supplies the by-id data (keeps the hook free of entity imports); pages keep instant-open-from-row-click.

## Scope

### Phase 1 — audit logs (fixes #6582)

- Backend: `GET /api/audit-logs/:id` — new route in `platform/backend/src/routes/audit-log.ts` (today only `GetAuditLogs` exists), `findById` in `platform/backend/src/models/audit-log.ts`, org-scoped, permission `auditLog: ["read"]` added to `requiredEndpointPermissionsMap` (same as `GetAuditLogs`, `platform/shared/access-control.ts:1448`), OpenAPI codegen.
- Frontend: generic hook + wire the detail dialog to `?event=<id>`; add a copy-link affordance in the dialog header.
- Tests: backend unit tests for the new endpoint (incl. cross-org 404); e2e for the deep link.

### Phase 2 — converge existing implementations

Migrate onto the generic hook (no UX change): `/agents` (`?edit`/`?view`), `/llm/proxies` (`?edit`), `/mcp/gateways` (`?edit`), `/skills` (bespoke copy), `/mcp/tool-guardrails` policy editor (bespoke `?toolId=`, already persistent-while-open). Also fix the one-way cases in the inventory's notes (param read on mount but never written back: registry detail tabs, identity providers, teams one-shot seed) — same mechanism, tiny diffs.

### Phase 3 — sweep the remaining object dialogs

One small PR per page. The full, source-verified gap list is **the "Not yet implemented" table of [shareable-urls-inventory.md](./shareable-urls-inventory.md)** — 28 object dialogs across 22 pages, including edit dialogs hiding on pages that already have `[id]` routes (knowledge connector edit, project edit, schedule trigger edit) and pages the first audit missed entirely (GitHub app configs, agent email settings, registry manage-users, role view-permissions, knowledge-base sub-dialogs). Most already have GET-by-id endpoints, so these are frontend-only.

## Success criteria

- Copy URL while an audit event dialog is open, open in a new tab: the same event opens (including events outside page 1 / current filters).
- One hook implementation; zero bespoke dialog-URL copies left after phase 2.
- No action dialog gained a persistent URL param.

## Alternatives considered

| Option | Simplicity | Link robustness | Consistency | Best practices | Preserves UX |
|---|---|---|---|---|---|
| Frontend-only `?event=<id>` (no by-id fetch) | 5 | 1 | 3 | 2 | 5 |
| `?event=<id>` + `GET /:id`, audit logs only | 3 | 5 | 4 | 5 | 5 |
| Dedicated `/audit/logs/[id]` page | 3 | 5 | 5 | 5 | 2 |
| **Generalized hook + app-wide pass (chosen)** | 1 | 5 | 5 | 5 | 4 |

- Frontend-only param: a shared link only resolves if the event is in the currently loaded page/filters — broken for old events.
- Audit-logs-only by-id variant: identical mechanism to the chosen option, scoped down; kept as phase 1.
- Dedicated `[id]` page: matches how `/llm/logs/[id]` and `/mcp/logs/[id]` work, but replaces the modal UX; the by-id endpoint from phase 1 keeps this door open if the product direction changes.
