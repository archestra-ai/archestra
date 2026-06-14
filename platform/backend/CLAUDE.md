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
