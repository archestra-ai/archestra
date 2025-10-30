# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Directory

**ALWAYS run all commands from the `platform/` directory unless specifically instructed otherwise.**

## Important Rules

1. **Use pnpm** for package management
2. **Use Biome for formatting and linting** - Run `pnpm lint` before committing
3. **TypeScript strict mode** - Ensure code passes `pnpm type-check` before completion
4. **Use Tilt for development** - `tilt up` to start the full environment
5. **Use shadcn/ui components** - Add with `npx shadcn@latest add <component>`

## Key URLs

- **Frontend**: <http://localhost:3000/>
- **Tools Inspector**: <http://localhost:3000/tools>
- **Dual LLM Config**: <http://localhost:3000/dual-llm>
- **Settings/Teams**: <http://localhost:3000/account/settings>
- **MCP Catalog**: <http://localhost:3000/mcp-catalog> (Install and manage MCP servers)
- **MCP Installation Requests**: <http://localhost:3000/mcp-catalog/installation-requests> (View/manage server installation requests)
- **Tilt UI**: <http://localhost:10350/>
- **Drizzle Studio**: <https://local.drizzle.studio/>
- **MCP Gateway**: <http://localhost:9000/v1/mcp> (GET for discovery, POST for JSON-RPC with session support, requires Bearer token auth)
- **MCP Proxy**: <http://localhost:9000/mcp_proxy/:id> (POST for JSON-RPC requests to K8s pods)
- **MCP Logs**: <http://localhost:9000/mcp_proxy/:id/logs> (GET pod logs)
- **MCP Restart**: <http://localhost:9000/api/mcp_server/:id/restart> (POST to restart pod)
- **Jaeger UI**: <http://localhost:16686/> (distributed tracing visualization)

## Common Commands

```bash
# Development
tilt up                                 # Start full development environment
pnpm dev                                # Start all workspaces
pnpm lint                               # Lint and auto-fix
pnpm type-check                         # Check TypeScript types
pnpm test                               # Run tests
pnpm test:e2e                           # Run e2e tests with Playwright (includes WireMock)

# Database
pnpm db:migrate      # Run database migrations
pnpm db:studio       # Open Drizzle Studio

# Logs
tilt logs pnpm-dev                   # Get logs for frontend + backend
tilt trigger <pnpm-dev|wiremock|etc> # Trigger an update for the specified resource
```

## Environment Variables

```bash
# Required
DATABASE_URL="postgresql://archestra:archestra_dev_password@localhost:5432/archestra_dev?schema=public"

# Provider API Keys
OPENAI_API_KEY=your-api-key-here
GEMINI_API_KEY=your-api-key-here
ANTHROPIC_API_KEY=your-api-key-here

# Provider Base URLs (optional - for testing)
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_BASE_URL=https://api.anthropic.com

# Kubernetes (for MCP server runtime)
K8S_NAMESPACE=default
KUBECONFIG=/path/to/kubeconfig  # Optional, defaults to in-cluster config or ~/.kube/config
USE_IN_CLUSTER_KUBECONFIG=false  # Set to true when running inside K8s cluster
MCP_SERVER_BASE_IMAGE=europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.3
```

## Architecture

**Tech Stack**: pnpm monorepo, Fastify backend (port 9000), Next.js frontend (port 3000), PostgreSQL + Drizzle ORM, Biome linting, Tilt orchestration, Kubernetes for MCP server runtime

**Key Features**: MCP tool execution, dual LLM security pattern, tool invocation policies, trusted data policies, MCP response modifiers (Handlebars.js), team-based access control (agents and MCP servers), MCP server installation request workflow, K8s-based MCP server runtime for local stdio servers

**Workspaces**:

- `backend/` - Fastify API server with security guardrails
- `frontend/` - Next.js app with tool management UI
- `experiments/` - CLI testing and proxy prototypes
- `shared/` - Common utilities and types

## Authentication

- **API Key Auth**: API keys can be used via `Authorization` header
- API keys have all permissions by default
- API keys work as fallback when session auth fails (e.g., "No active organization" errors)
- Use `pnpm test:e2e` to run API tests with API key authentication

## Coding Conventions

**Frontend**:

- Use TanStack Query for data fetching
- Use shadcn/ui components only
- Small focused components with extracted business logic
- Flat file structure, avoid barrel files
- Only export what's needed externally

**Backend**:

- Use Drizzle ORM for database operations
- Colocate test files with source (`.test.ts`)
- Flat file structure, avoid barrel files
- When adding a new route, you will likely need to add configuration to `routePermissionsConfig` in `backend/src/middleware/auth.ts` (otherwise the UI's consumption of those new route(s) will result in HTTP 403)
- Only export public APIs

**Team-based Access Control**:

- Agents and MCP servers use team-based authorization (not user-based)
- Teams managed via better-auth organization plugin
- Junction tables: `agent_team` and `mcp_server_team`
- Breaking change: `usersWithAccess[]` replaced with `teams[]` in APIs
- Admin-only team CRUD operations via `/api/teams/*` routes
- Members can read teams and access team-assigned agents/MCP servers

**MCP Server Installation Requests**:

- Members can request MCP servers from external catalog
- Admins approve/decline requests with optional messages
- Prevents duplicate pending requests for same catalog item
- Full timeline and notes functionality for collaboration

**MCP Server Runtime**:

- Local stdio-based MCP servers run in K8s pods (one pod per server)
- Automatic pod lifecycle management (start/restart/stop)
- JSON-RPC proxy for communication with pods via `/mcp_proxy/:id`
- Pod logs available via `/mcp_proxy/:id/logs`
- K8s configuration: K8S_NAMESPACE, KUBECONFIG, USE_IN_CLUSTER_KUBECONFIG, MCP_SERVER_BASE_IMAGE
- Runtime manager at `backend/src/mcp-server-runtime/`

**Testing**: Vitest with PGLite for in-memory PostgreSQL testing, Playwright e2e tests with WireMock for API mocking
