# Site Notification And Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a permissioned site notification banner and environment-driven maintenance mode for Archestra.

**Architecture:** Use dedicated notification routes with a dedicated RBAC resource so read permissions are enforced by the API boundary. Keep maintenance mode environment-driven and expose it through config for the frontend to gate the app shell.

**Tech Stack:** Fastify, Drizzle ORM, Vitest, Next.js, TanStack Query, shadcn/ui.

---

### Task 1: Maintenance Config

**Files:**
- Modify: `platform/backend/src/config.ts`
- Test: `platform/backend/src/config.test.ts`
- Modify: `platform/backend/src/routes/config.ts`
- Test: `platform/backend/src/routes/config.test.ts`

- [ ] Write failing tests for maintenance env parsing and public config exposure.
- [ ] Run targeted tests and verify they fail for the missing maintenance behavior.
- [ ] Implement the minimal config parsing and route response changes.
- [ ] Re-run targeted tests and verify they pass.

### Task 2: Site Notification Backend

**Files:**
- Modify: `platform/shared/permission.types.ts`
- Modify: `platform/shared/access-control.ts`
- Modify: `platform/shared/routes.ts`
- Modify: `platform/backend/src/database/schemas/organization.ts`
- Modify: `platform/backend/src/types/organization.ts`
- Modify: `platform/backend/src/models/organization.ts`
- Modify: `platform/backend/src/routes/organization.ts`
- Test: colocated backend tests for organization routes

- [ ] Write failing tests for notification read and update permissions, plus expiration filtering.
- [ ] Run targeted tests and verify they fail for the expected missing behavior.
- [ ] Implement the minimal schema, model, type, route, and permission changes.
- [ ] Re-run targeted tests and verify they pass.

### Task 3: Maintenance Middleware

**Files:**
- Modify: `platform/backend/src/middleware.ts` or a dedicated middleware file
- Modify: `platform/backend/src/server.ts` if registration changes are required
- Test: colocated middleware tests if the repo has a fitting pattern

- [ ] Write a failing test that proves restricted routes are blocked during maintenance while bootstrap routes remain available.
- [ ] Run the targeted test and verify it fails for the expected reason.
- [ ] Implement the minimal blocking middleware and route allowlist.
- [ ] Re-run the targeted test and verify it passes.

### Task 4: Frontend Notification And Maintenance UI

**Files:**
- Modify: `platform/frontend/src/app/_parts/app-shell.tsx`
- Modify: `platform/frontend/src/app/settings/organization/page.tsx`
- Modify: `platform/frontend/src/lib/organization.query.ts`
- Modify: `platform/frontend/src/lib/config/config.query.ts` if needed
- Create or modify: focused components for the notification editor, banner, and maintenance screen
- Test: colocated frontend tests for those focused components

- [ ] Write failing frontend tests for maintenance gating and notification rendering.
- [ ] Run targeted tests and verify they fail for the missing behavior.
- [ ] Implement the minimal UI and query changes.
- [ ] Re-run the targeted tests and verify they pass.

### Task 5: Docs And Verification

**Files:**
- Modify: `docs/pages/platform-deployment.md`

- [ ] Update deployment docs for the new maintenance env vars.
- [ ] Run focused verification for changed backend and frontend tests.
- [ ] Run broader verification: `pnpm type-check`, `pnpm lint`, and relevant test commands.
- [ ] Stop before commit or push and summarize results for the user.
