---
title: Developer Quickstart
description: Run Archestra from source with Tilt and a local Kubernetes cluster.
order: 1
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

The development environment runs the backend and frontend on your machine with hot reload. PostgreSQL and MCP servers run in a local Kubernetes cluster. [Tilt](https://tilt.dev) starts all of it with one command and rebuilds what you change.

## Prerequisites

- **Node.js** 20 to 24.
- pnpm. Run `corepack enable` to use the version pinned in `platform/package.json`.
- **Rust**, installed with [rustup](https://rustup.rs). Native addons build on startup. rustup installs the toolchain version pinned in `platform/rust-toolchain.toml`.
- [Tilt](https://docs.tilt.dev/install.html), [kubectl](https://kubernetes.io/docs/tasks/tools/), and [Helm](https://helm.sh/docs/intro/install/).
- **A local Kubernetes cluster:** [OrbStack](https://orbstack.dev), Docker Desktop with Kubernetes turned on, [kind](https://kind.sigs.k8s.io) (cluster named `kind` or `archestra`), or [Colima](https://github.com/abiosoft/colima). Tilt refuses to deploy to any other kubectl context.

## Starting the Environment

```bash
git clone https://github.com/archestra-ai/archestra.git
cd archestra/platform
tilt up
```

On the first run, Tilt copies `.env.example` to `.env`, installs dependencies and the git pre-commit hook, deploys PostgreSQL, and runs migrations. Then it starts the backend on port 9000 and the frontend on port 3000. Press the space bar to open the Tilt UI at <http://localhost:10350> and follow each resource as it starts.

When `pnpm-dev-backend` and `pnpm-dev-frontend` are green in the Tilt UI, open <http://localhost:3000> and sign in as `admin@example.com` with the password `password`.

`tilt down` stops the environment.

## Configuring the Environment

Settings live in `platform/.env`. Tilt watches the file and restarts the backend and frontend when you save it. Every variable is listed in [Configuration](/docs/reference/configuration).

To chat without adding a provider key in the UI, set a fallback key for the built-in Chat:

```dotenv
ARCHESTRA_CHAT_ANTHROPIC_API_KEY=sk-ant-...
```

To skip the sign-in screen, set [`ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL=admin@example.com`](/docs/reference/configuration#ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL). It has no effect in a production build.

Two features deploy extra services only when you turn them on:

- [`ARCHESTRA_CODE_RUNTIME_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_ENABLED) deploys the Dagger engine behind the [Code Sandbox](/docs/agents#code-sandbox).
- [`ARCHESTRA_FILE_STORAGE_PROVIDER=s3`](/docs/reference/configuration#ARCHESTRA_FILE_STORAGE_PROVIDER) deploys MinIO as the file store.

## Everyday Commands

Run these from `platform/`:

- `pnpm lint:fix` formats and lints with Biome.
- `pnpm type-check` type-checks every workspace.
- `pnpm test` runs the unit and integration tests. Backend tests use an in-memory PostgreSQL and do not need Tilt.
- `pnpm codegen` regenerates the OpenAPI spec and the typed API client. Run it after you change a route's request or response schema.
- `pnpm db:generate` generates a migration after you change a Drizzle schema.
- `tilt logs pnpm-dev-backend` prints the backend logs. Use `pnpm-dev-frontend` for the frontend.

The pre-commit hook runs the type check, Biome, and Knip (unused exports). It blocks the commit when one fails.

To query the development database:

```bash
kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password psql -U archestra -d archestra_dev
```

## Running a Second Stack

A second environment runs in its own git worktree, on free ports and in its own Kubernetes namespace. Two branches can then run side by side. From the repository root, create the worktree, copy your `.env` into it, and start the stack:

```bash
git worktree add ../archestra-feature -b feature
cp platform/.env ../archestra-feature/platform/.env
cd ../archestra-feature/platform
pnpm dev:stack:up --detach
```

`--detach` runs Tilt in the background and returns when the frontend responds. `pnpm dev:stack:status` lists every running stack and its URL. `pnpm dev:stack:down` stops the stack in the current worktree.

## Installing Dependencies

pnpm refuses package versions published less than seven days ago. When an install fails for that reason, choose an older version.

pnpm also does not run package install scripts in this repository. Both settings are in `platform/pnpm-workspace.yaml`. If a package needs its install script to work, run it for that package only:

```bash
pnpm rebuild <package-name>
```
