---
title: Developer Quickstart
description: Run Archestra from source with Tilt and a local Kubernetes cluster
order: 1
lastUpdated: 2026-10-19
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

One command runs all of Archestra from source, with hot reload. The backend and frontend run on your machine. PostgreSQL and MCP servers run in a local Kubernetes cluster. [Tilt](https://tilt.dev) starts everything and rebuilds what you change.

## Prerequisites

- Node.js 20 to 24. The repository pins 24 in `.nvmrc`, and pnpm refuses to install on other versions.
- pnpm. Run `corepack enable` to use the version pinned in `platform/package.json`.
- Rust, installed with [rustup](https://rustup.rs). rustup installs the toolchain pinned in `platform/rust-toolchain.toml`.
- [Tilt](https://docs.tilt.dev/install.html), [kubectl](https://kubernetes.io/docs/tasks/tools/), and [Helm](https://helm.sh/docs/intro/install/).
- A local Kubernetes cluster: [OrbStack](https://orbstack.dev), Docker Desktop with Kubernetes turned on, [kind](https://kind.sigs.k8s.io) (cluster named `kind` or `archestra`), or [Colima](https://github.com/abiosoft/colima). Tilt refuses to deploy to any other kubectl context.

<span id="starting-the-environment"></span>

## Start the Environment

```bash
git clone https://github.com/archestra-ai/archestra.git
cd archestra/platform
tilt up
```

Tilt creates `.env` from `.env.example` if it is missing. Then it installs dependencies and the git pre-commit hook, builds the Rust addons, deploys PostgreSQL, runs migrations, and starts the backend on port 9000 and the frontend on port 3000. The first start takes several minutes. Press the space bar to follow each resource in the Tilt UI at <http://localhost:10350>.

When `pnpm-dev-backend` and `pnpm-dev-frontend` are green, open <http://localhost:3000> and sign in as `admin@example.com` with the password `password`.

`tilt down` stops the environment.

<span id="configuring-the-environment"></span>

## Configure the Environment

Settings live in `platform/.env`. Tilt restarts the backend and frontend when you save it. Every variable is listed in [Configuration](/docs/reference/configuration).

To chat without adding a provider key in the UI, set an Anthropic key. Archestra adds it as the organization's Anthropic key at startup:

```dotenv
ARCHESTRA_CHAT_ANTHROPIC_API_KEY=sk-ant-...
```

To skip the sign-in screen, set [`ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL=admin@example.com`](/docs/reference/configuration#ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL). It has no effect in a production build.

Two features need extra services, which start only when you turn them on:

- [`ARCHESTRA_CODE_RUNTIME_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_ENABLED) turns on the [Code Sandbox](/docs/agents#code-sandbox). Tilt builds its native addon, and the backend starts a Dagger engine in your cluster.
- [`ARCHESTRA_FILE_STORAGE_PROVIDER=s3`](/docs/reference/configuration#ARCHESTRA_FILE_STORAGE_PROVIDER) deploys MinIO as the file store.

## Everyday Commands

Run these from `platform/`:

- `pnpm lint:fix` formats and lints with Biome.
- `pnpm type-check` type-checks every workspace.
- `pnpm test` runs the unit and integration tests. Backend tests use an in-memory PostgreSQL and do not need Tilt. Without Tilt, build the native addons first: `pnpm --filter '@archestra/*-rs' build:dev`.
- `pnpm test:e2e:lite:up`, then `pnpm test:e2e:lite`, runs the Playwright suite against a stack in Docker. Stop Tilt first, because both use the same ports.
- `pnpm codegen` regenerates the OpenAPI spec, the typed API client, and the generated reference pages. Run it with Tilt up after you change a route's request or response schema.
- `pnpm db:generate` generates a migration after you change a Drizzle schema.
- `tilt logs pnpm-dev-backend` prints the backend logs. Use `pnpm-dev-frontend` for the frontend.

The pre-commit hook runs the type check, Biome, and Knip (unused exports) in each workspace, plus the migration checks in the backend. It blocks the commit when one fails.

Tilt also starts Drizzle Studio at <https://local.drizzle.studio> to browse the development database. To use `psql` instead:

```bash
kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password psql -U archestra -d archestra_dev
```

Coding agents read `AGENTS.md` and the skills in `.agents/skills/` for the repository's conventions.

<span id="before-joining-the-merge-queue"></span>

## Queue a Pull Request

Maintainers merge through the GitHub merge queue. Sign in to the GitHub CLI, check out the finished PR head with no local changes, and run this from `platform/`, with your PR number:

```bash
pnpm enqueue 1234
```

It runs the fast checks (types, Biome, Knip, white-label copy, and frontend and shared unit tests), then queues that exact revision. The queue runs the full build and every test suite.

- The PR must be open, out of draft, and pass its required checks.
- PR titles follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`). A CI check rejects other titles.
- Pass `--repo owner/name` when `origin` is not the PR's repository.

<span id="running-a-second-stack"></span>

## Run a Second Stack

Run two branches side by side. Each stack gets its own git worktree, free ports, and its own Kubernetes namespace. From the repository root:

```bash
git worktree add ../archestra-feature -b feature
cd ../archestra-feature/platform
pnpm dev:stack:up --detach
```

`dev:stack:up` copies your `.env` from the main checkout and gives the stack its own ports. `--detach` runs Tilt in the background and returns when the frontend responds.

- `pnpm dev:stack:status` lists every worktree, whether its stack responds, and its URL.
- `pnpm dev:stack:hydrate` copies your LLM provider keys from the main stack, so chat works without entering them again.
- `pnpm dev:stack:down` stops the stack in the current worktree.

<span id="installing-dependencies"></span>

## Add a Dependency

pnpm refuses package versions published less than seven days ago. When an install fails for that reason, choose an older version.

pnpm also skips package install scripts in this repository. Both settings are in `platform/pnpm-workspace.yaml`. If a package needs its install script to work, run it for that package only:

```bash
pnpm rebuild <package-name>
```
