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
- **Backend**: <http://localhost:9000/> (Fastify API server)
- **Chat**: <http://localhost:3000/chat> (n8n expert chat with MCP tools)
- **Tools Inspector**: <http://localhost:3000/tools>
- **Settings**: <http://localhost:3000/settings> (Main settings page with tabs for LLM & MCP Gateways, Dual LLM, Your Account, Members, Teams, Appearance)
- **Appearance Settings**: <http://localhost:3000/settings/appearance> (Admin-only: customize theme, logo, fonts)
- **MCP Catalog**: <http://localhost:3000/mcp-catalog> (Install and manage MCP servers)
- **MCP Installation Requests**: <http://localhost:3000/mcp-catalog/installation-requests> (View/manage server installation requests)
- **LLM Proxy Logs**: <http://localhost:3000/logs/llm-proxy> (View LLM proxy request logs)
- **MCP Gateway Logs**: <http://localhost:3000/logs/mcp-gateway> (View MCP tool call logs)
- **Tilt UI**: <http://localhost:10350/>
- **Drizzle Studio**: <https://local.drizzle.studio/>
- **MCP Gateway**: <http://localhost:9000/v1/mcp> (GET for discovery, POST for JSON-RPC with session support, requires Bearer token auth)
- **MCP Proxy**: <http://localhost:9000/mcp_proxy/:id> (POST for JSON-RPC requests to K8s pods)
- **MCP Logs**: <http://localhost:9000/api/mcp_server/:id/logs> (GET container logs, ?lines=N to limit, ?follow=true for streaming)
- **MCP Restart**: <http://localhost:9000/api/mcp_server/:id/restart> (POST to restart pod)
- **Tempo API**: <http://localhost:3200/> (Tempo HTTP API for distributed tracing)
- **Grafana**: <http://localhost:3002/> (metrics and trace visualization, manual start via Tilt)
- **Tempo API**: <http://localhost:3200/> (Tempo HTTP API for distributed tracing)
- **Prometheus**: <http://localhost:9090/> (metrics storage, starts with Grafana)
- **Backend Metrics**: <http://localhost:9050/metrics> (Prometheus metrics endpoint, separate from main API)
- **MCP Tool Calls API**: <http://localhost:9000/api/mcp-tool-calls> (GET paginated MCP tool call logs)

## Common Commands

```bash
# Development
tilt up                                 # Start full development environment
pnpm dev                                # Start all workspaces
pnpm lint                               # Lint and auto-fix
pnpm type-check                         # Check TypeScript types
pnpm test                               # Run tests
pnpm test:e2e                           # Run e2e tests with Playwright (chromium, webkit, firefox) (chromium, webkit, firefox)

# Database
pnpm db:migrate      # Run database migrations
pnpm db:studio       # Open Drizzle Studio

# Logs
tilt logs pnpm-dev                   # Get logs for frontend + backend
tilt trigger <pnpm-dev|wiremock|etc> # Trigger an update for the specified resource

# Testing with WireMock
tilt trigger orlando-wiremock        # Start orlando WireMock test environment (port 9091)

# Observability
tilt trigger observability           # Start full observability stack (Tempo, OTEL Collector, Prometheus, Grafana)
docker compose -f dev/docker-compose.observability.yml up -d  # Alternative: Start via docker-compose
```

## Environment Variables

```bash
# Database Configuration
# ARCHESTRA_DATABASE_URL takes precedence over DATABASE_URL
# When using external database, internal postgres container will not start
ARCHESTRA_DATABASE_URL="postgresql://archestra:archestra_dev_password@localhost:5432/archestra_dev?schema=public"

# Provider API Keys
OPENAI_API_KEY=your-api-key-here
GEMINI_API_KEY=your-api-key-here
ANTHROPIC_API_KEY=your-api-key-here

# Provider Base URLs (optional - for testing)
ARCHESTRA_OPENAI_BASE_URL=https://api.openai.com/v1
ARCHESTRA_ANTHROPIC_BASE_URL=https://api.anthropic.com

# Analytics (optional - disabled for local dev and e2e tests)
ARCHESTRA_ANALYTICS=disabled  # Set to "disabled" to disable PostHog analytics

# Chat Feature Configuration (n8n automation expert)
ARCHESTRA_CHAT_ANTHROPIC_API_KEY=your-api-key-here  # Required for chat (direct Anthropic API)
ARCHESTRA_CHAT_DEFAULT_MODEL=claude-opus-4-1-20250805  # Optional, defaults to claude-opus-4-1-20250805
ARCHESTRA_CHAT_MCP_SERVER_URL=http://localhost:9000/v1/mcp  # Optional, for MCP tool integration
ARCHESTRA_CHAT_MCP_SERVER_HEADERS={"Authorization":"Bearer token"}  # Optional JSON headers

# Kubernetes (for MCP server runtime)
ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE=default
ARCHESTRA_ORCHESTRATOR_KUBECONFIG=/path/to/kubeconfig  # Optional, defaults to in-cluster config or ~/.kube/config
ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER=false  # Set to true when running inside K8s cluster
ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE=europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.3  # Default image when custom Docker image not specified
NEXT_PUBLIC_ARCHESTRA_MCP_SERVER_BASE_IMAGE=europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.3  # Frontend display of base image

# OpenTelemetry Authentication
ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME=  # Username for OTLP basic auth (requires password)
ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD=  # Password for OTLP basic auth (requires username)
ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER=    # Bearer token for OTLP auth (takes precedence over basic auth)

# Logging
ARCHESTRA_LOGGING_LEVEL=info  # Options: trace, debug, info, warn, error, fatal
```

## Architecture

**Tech Stack**: pnpm monorepo, Fastify backend (port 9000), metrics server (port 9050), Next.js frontend (port 3000), PostgreSQL + Drizzle ORM, Biome linting, Tilt orchestration, Kubernetes for MCP server runtime

**Key Features**: MCP tool execution, dual LLM security pattern, tool invocation policies, trusted data policies, MCP response modifiers (Handlebars.js), team-based access control (agents and MCP servers), MCP server installation request workflow, K8s-based MCP server runtime with stdio and streamable-http transport support, white-labeling (themes, logos, fonts), n8n automation chat with MCP tools, built-in Archestra MCP tools (whoami, search_private_mcp_registry, create_mcp_server_installation_request)

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

## Observability

**Tracing**: LLM proxy routes add agent data via `startActiveLlmSpan()`. Traces include `agent.id`, `agent.name` and dynamic `agent.<label>` attributes. Agent label keys are fetched from database on startup and included as resource attributes. Traces stored in Grafana Tempo.

**Metrics**: Prometheus metrics (`llm_request_duration_seconds`, `llm_tokens_total`) include `agent_name`, `agent_id` and dynamic agent labels as dimensions. Metrics are reinitialized on startup with current label keys from database.

**Local Setup**: Use `tilt trigger observability` or `docker compose -f dev/docker-compose.observability.yml up` to start Tempo, Prometheus, and Grafana with pre-configured datasources.

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
- Use the `logger` instance from `@/logging` for all logging (replaces console.log/error/warn/info)

**Team-based Access Control**:

- Agents and MCP servers use team-based authorization (not user-based)
- Teams managed via better-auth organization plugin
- Junction tables: `agent_team` and `mcp_server_team`
- Breaking change: `usersWithAccess[]` replaced with `teams[]` in APIs
- Admin-only team CRUD operations via `/api/teams/*` routes
- Members can read teams and access team-assigned agents/MCP servers

**Agent Labels**:

- Agents support key-value labels for organization/categorization
- Database schema: `label_keys`, `label_values`, `agent_labels` tables
- Keys and values stored separately for consistency and reuse
- One value per key per agent (updating same key replaces value)
- Labels returned in alphabetical order by key for consistency
- API endpoints: GET `/api/agents/labels/keys`, GET `/api/agents/labels/values?key=<key>` (key param filters values by key)

**MCP Server Installation Requests**:

- Members can request MCP servers from external catalog
- Admins approve/decline requests with optional messages
- Prevents duplicate pending requests for same catalog item
- Full timeline and notes functionality for collaboration

**MCP Server Runtime**:

- Local MCP servers run in K8s pods (one pod per server)
- Automatic pod lifecycle management (start/restart/stop)
- Two transport types supported:
  - **stdio** (default): JSON-RPC proxy communication via `/mcp_proxy/:id` using `kubectl attach`
  - **streamable-http**: Native HTTP/SSE transport using K8s Service (better performance, concurrent requests)
- Pod logs available via `/api/mcp_server/:id/logs` endpoint
  - Query parameters: `?lines=N` to limit output, `?follow=true` for real-time streaming
  - Streaming uses chunked transfer encoding similar to `kubectl logs -f`
- K8s configuration: ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE, ARCHESTRA_ORCHESTRATOR_KUBECONFIG, ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER, ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE
- Custom Docker images supported per MCP server (overrides ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE)
- When using Docker image, command is optional (uses image's default CMD if not specified)
- Runtime manager at `backend/src/mcp-server-runtime/`

**Configuring Transport Type**:
- Set `transportType: "streamable-http"` in `localConfig` for HTTP transport
- Optionally specify `httpPort` (defaults to 8080) and `httpPath` (defaults to /mcp)
- Stdio transport serializes requests (one at a time), HTTP allows concurrent connections
- HTTP servers get automatic K8s Service creation with ClusterIP DNS name
- For streamable-http servers: K8s Service uses NodePort in local dev, ClusterIP in production

**Helm Chart**:

- RBAC: ServiceAccount with configurable name/annotations for pod identity
- RBAC: Role with permissions: pods (all verbs), pods/exec, pods/log, pods/attach
- RBAC: Configure via `serviceAccount.create`, `rbac.create` in values.yaml
- Service annotations via `archestra.service.annotations` (e.g., GKE BackendConfig)
- Optional Ingress: Enable with `archestra.ingress.enabled`, supports custom hosts, paths, TLS, annotations, or full spec override
- Secret-based env vars via `archestra.envFromSecrets` for sensitive data injection (e.g., API keys from K8s Secrets)
- Bulk env var import via `archestra.envFrom` for importing all keys from Secrets/ConfigMaps at once

**White-labeling**:
- Admin-only via `/api/organization/appearance` endpoints  
- Custom logos: PNG only, max 2MB, stored as base64
- 5 fonts: Lato, Inter, Open Sans, Roboto, Source Sans Pro
- Real-time theme and font preview in settings
- Custom logos display with "Powered by Archestra" attribution
- Database columns: theme, customFont, logoType, logo

**Archestra MCP Server**:
- Built-in tools automatically injected into all agents
- Tools prefixed with "archestra__" to avoid conflicts
- Available tools:
  - `archestra__whoami`: Returns agent name and ID
  - `archestra__search_private_mcp_registry`: Search internal MCP catalog
- Planned tool (temporarily disabled):
  - `archestra__create_mcp_server_installation_request`: Request MCP server installation (disabled pending user context availability)
- Implementation: `backend/src/archestra-mcp-server.ts`

**Testing**: Vitest with PGLite for in-memory PostgreSQL testing, Playwright e2e tests (chromium, webkit, firefox) with WireMock for API mocking
