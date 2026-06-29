# Backend architecture

A small set of rules for how routes, services, and models interact in the Fastify + Drizzle backend.

## Layers

```
routes → services → models → database
```

- **Routes** (`backend/src/routes/`) — Fastify handlers. Parse and validate the request (Zod schemas via `fastify-type-provider-zod`), call a service, serialize the response. No business logic, no direct model access.
- **Services** (`backend/src/services/`) — Business logic, cross-model orchestration, transactions.
- **Models** (`backend/src/models/`) — Database access only. One file per table. Models own Drizzle queries; nothing else owns them.


## Principles

### 1. Models do not call other models, except using joins.

### 2. Models do not call services. Imports go one way only: `services → models`, never the reverse.

### 3. Business logic lives in services. Anything that touches more than one model, makes external API calls, or performs scoped authorization checks should belong to a service. Dependencies go one way: routes use services; services use models. If all route is just one model call it's OK to use a model directly.

