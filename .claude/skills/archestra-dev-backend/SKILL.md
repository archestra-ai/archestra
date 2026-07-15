---
name: archestra-dev-backend
description: Use when adding or changing Archestra backend routes, models, services, API request/response schemas, endpoint permissions, or OpenAPI/codegen for the generated API client.
---

# Archestra Backend Development

Use this skill before changing files under `platform/backend/` (except unit tests — see `archestra-dev-backend-tests`). Run all commands from `platform/`.

## Adding or changing an API endpoint

1. Add a `RouteId` entry in `platform/shared/routes.ts` and set it as the route schema's `operationId`.
2. Add the route handler (see Route layout and Route conventions below).
3. Add the endpoint to `requiredEndpointPermissionsMap` in `platform/shared/access-control.ts` (see The 403 footgun).
4. Check the MCP-tool mirror (see below).
5. Run codegen, then validation (see Codegen and Validation).

## Route layout

- New routes live in per-entity folders: `backend/src/routes/<entity>/<entity>.routes.ts` holds ALL of that entity's endpoints; tests are one file per endpoint in the same folder, named `<action>.<entity>.route.test.ts` (see `routes/app/` for a full example).
- Canonical reference: copy the shape of `backend/src/routes/virtual-api-key/virtual-api-key.routes.ts` and `create.virtual-api-key.route.test.ts`.
- Legacy flat modules (`routes/agent.ts`, `routes/user.ts`, ...) still exist — extend them only for their own entity; new entities get a folder.
- Registration is automatic: `registerApiRoutes` in `backend/src/server.ts` iterates `Object.values(routes)` from `routes/index.ts` (and `routes/index.ee.ts` for enterprise routes), so the default re-export in the index file is mandatory or the route silently never registers.

## The 403 footgun (deny by default)

- Every new endpoint MUST be added to `requiredEndpointPermissionsMap` in `platform/shared/access-control.ts`, keyed by its `RouteId`. The auth middleware (`backend/src/auth/fastify-plugin/middleware.ts`, `isAuthorized`) looks the route up by `operationId` and denies with 403 when the entry is missing.
- The map is `Partial<Record<RouteId, Permissions>>` — NOT compiler-enforced; forgetting it compiles fine and fails at runtime.
- An empty entry `{}` means "any authenticated user". Match permissions with similar existing routes.
- Evaluate RBAC from the database, never from the session-cookie cache — the cookie can carry a stale `activeOrganizationId` snapshot. Follow `backend/src/auth/utils.ts` (member role + custom roles resolved via models).

## Route conventions

- Plugins are typed as `FastifyPluginAsyncZod` (fastify-type-provider-zod); schemas are Zod.
- Wrap response schemas with `constructResponseSchema` from `@/types` for consistent 400/401/403/404/500 responses.
- Errors: `throw new ApiError(status, message)` (from `@/types`) only — never `reply.status().send(...)`; the central error handler formats `{ error: { message, type } }`.
- Routes under `/api/` are behind the auth middleware: `request.user` and `request.organizationId` are guaranteed — no redundant null checks.
- Pagination: `PaginationQuerySchema` + `createPaginatedResponseSchema` from `@archestra/shared`.
- Sorting: `SortingQuerySchema` or `createSortingQuerySchema` from `@/types`.

## Data access

- All DB queries go through `backend/src/models/` — never inline Drizzle in routes or services. Create a model file for new entities; business logic stays in services.
- Batch-load related data to avoid N+1 (e.g. `AgentTeamModel.getTeamsForAgents` in `backend/src/models/agent-team.ts`), never per-item queries in a loop.
- Entity types come from drizzle-zod (`createSelectSchema` / `createInsertSchema` / `createUpdateSchema` + `z.infer`), never hand-written interfaces. See the Database Types section in `platform/CLAUDE.md`.
- Schema changes: use the `archestra-dev-migrations` skill.

## MCP-tool mirror

- When an endpoint's request/response schema changes, check for a mirrored `archestra__*` tool in `backend/src/archestra-mcp-server/` and update its `inputSchema` and handler in sync.
- New tools need a `TOOL_PERMISSIONS` entry in `backend/src/archestra-mcp-server/rbac.ts` — that one IS compile-enforced (`Record<ArchestraToolShortName, ...>`).

## Codegen

After any route/schema change, regenerate and commit the outputs — CI runs `pnpm codegen` and fails on uncommitted diffs (`.github/workflows/on-pull-requests.yml`):

```bash
pnpm codegen   # from platform/: everything (backend openapi + access-control docs + MCP-server docs, shared api-client + theme css, Grafana dashboard variants via python3)
```

Or piecewise, in this order: `cd backend && pnpm codegen` (writes the repo-root `docs/openapi.json` + docs), then `cd shared && CODEGEN=true pnpm codegen:api-client`. The `CODEGEN=true` is required: with it, `shared/hey-api/openapi-ts.ts` reads the committed `docs/openapi.json`; without it, it hits a live `http://localhost:9000/openapi.json` and silently ignores the spec you just regenerated.

## Validation

```bash
pnpm type-check
pnpm lint
pnpm test
cd backend && pnpm knip   # runs knip:dev AND knip:production — CI runs both; --production ignores tests, so a test-only export fails it
```

## Adding config / env vars

- Name: `ARCHESTRA_<PRODUCT_AREA>_<THING>`. Then: parse/validate in `backend/src/config.ts` (+ tests in `config.test.ts` for custom parsers) → list in `platform/.env.example` with a comment → document in `../docs/pages/platform-deployment.md` → expose via `backend/src/routes/config.ts` + `useFeature()` if the frontend needs it.

## Related skills

- `archestra-dev-backend-tests` — unit tests, mocking rules, DB fixtures.
- `archestra-dev-migrations` — Drizzle schema and migration changes.
- `archestra-dev-frontend` — consuming the regenerated API client.
