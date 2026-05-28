# Backend architecture

A small set of rules for how routes, services, and models interact in the Fastify + Drizzle backend. 

## Layers

```
routes → services → models → database
```

- **Routes** (`backend/src/routes/`) — Fastify handlers. Parse and validate the request (Zod schemas via `fastify-type-provider-zod`), call a model or a service, serialize the response. No business logic.
- **Services** (`backend/src/services/`) — Business logic, cross-model orchestration, transactions.
- **Models** (`backend/src/models/`) — Database access only. One file per table. Models own Drizzle queries; nothing else owns them.

Dependencies go one way: routes can use services or models; services can use models;

## Principles

### 1. Models do not call other models, except using joins.

### 2. Models do not call services. Imports go one way only: `services → models`, never the reverse.

### 3. Business logic lives in services. Anything that touches more than one model, external API Calls, scoped Authorization checks should belong to the service.

