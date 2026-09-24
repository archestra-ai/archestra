# Backend conventions

## File organization
- Routes are grouped per entity: one routes file per entity at
  `/src/routes/<entity>/<entity>.routes.ts`
  (e.g. `/src/routes/users/users.routes.ts` holds ALL user endpoints).
- Tests are per endpoint, one file per endpoint, in the same entity folder:
  `<action>.<entity>.route.test.ts`
  (e.g. `/src/routes/users/create.users.route.test.ts`, `get.users.route.test.ts`).

## Canonical reference
- Routes file: match `/src/routes/virtual-api-key/virtual-api-key.routes.ts`.
  When adding an endpoint to any entity, copy its shape.
- Test file: match `/src/routes/virtual-api-key/create.virtual-api-key.route.test.ts`.
  When writing a new endpoint test, copy its shape.

## Test import boundaries
- Name a test `*.unit.test.ts` only when its runtime imports do not reach the
  database, models, application config, server entry point, or database fixtures.
  These tests run without PGlite or a database URL. Import test APIs from
  `vitest`, not `@/test`.
- Keep `*.test.ts` for database-backed and route tests. Use real PGlite and
  fixtures for database behavior.
- In database-backed tests that do not use fixtures, import test APIs directly
  from `vitest`; importing `@/test` loads the entire fixture graph. The
  `check:test-imports` command rejects unused fixture imports.
- In route tests, import the Fastify factory from `@/fastify-instance` and the
  route helper from `@/test/route-test-app`. Do not import `@/server` from a test
  or re-export route helpers through the general `@/test` barrel.
- Before adding a database-free test, run `pnpm --dir backend check:test-imports`
  from `platform/`. Biome enforces direct imports; dependency-cruiser checks
  transitive runtime imports in `*.unit.test.ts` files.
