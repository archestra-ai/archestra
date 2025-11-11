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
- **Roles**: <http://localhost:3000/settings/roles> (Admin-only: manage custom RBAC roles)
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
pnpm test:e2e                           # Run e2e tests with Playwright (chromium, webkit, firefox)

# Database
pnpm db:migrate      # Run database migrations
pnpm db:studio       # Open Drizzle Studio

# Logs
tilt logs pnpm-dev                   # Get logs for frontend + backend
tilt trigger <pnpm-dev|wiremock|etc> # Trigger an update for the specified resource

# Testing with WireMock
tilt trigger orlando-wiremock        # Start orlando WireMock test environment (port 9091)

# E2E Testing
pnpm test:e2e                        # Run Playwright tests
# Local: docker-compose setup (Tiltfile.test)
# CI: kind cluster + helm deployment
#   - kind config: .github/kind.yaml
#   - helm values: .github/values-ci.yaml
#   - NodePort services: frontend:3000, backend:9000, metrics:9050

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

# Feature Flags
NEXT_PUBLIC_ARCHESTRA_ENABLE_TEAM_AUTH=false  # Enable team-based authentication/installation for MCP servers (disabled by default)

# Authentication Secret (auto-generated in Helm/Docker if not set)
# In Helm: Auto-generated on first install and persisted
# In Docker: Auto-generated and saved to /app/data/.auth_secret
ARCHESTRA_AUTH_SECRET=  # Optional: Set manually, or leave empty for auto-generation

# Chat Feature Configuration (n8n automation expert)
ARCHESTRA_CHAT_ANTHROPIC_API_KEY=your-api-key-here  # Required for chat (direct Anthropic API)
ARCHESTRA_CHAT_DEFAULT_MODEL=claude-opus-4-1-20250805  # Optional, defaults to claude-opus-4-1-20250805

# Kubernetes (for MCP server runtime)
# Local MCP servers require EITHER ARCHESTRA_ORCHESTRATOR_KUBECONFIG OR ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER
ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE=default
ARCHESTRA_ORCHESTRATOR_KUBECONFIG=/path/to/kubeconfig  # Path to kubeconfig file
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

**Key Features**: MCP tool execution, dual LLM security pattern, tool invocation policies, trusted data policies, MCP response modifiers (Handlebars.js), team-based access control (agents and MCP servers), MCP server installation request workflow, K8s-based MCP server runtime with stdio and streamable-http transport support, white-labeling (themes, logos, fonts), agent-based chat with MCP tools, built-in Archestra MCP tools (whoami, search_private_mcp_registry, create_mcp_server_installation_request)

**Workspaces**:

- `backend/` - Fastify API server with security guardrails
- `frontend/` - Next.js app with tool management UI
- `experiments/` - CLI testing and proxy prototypes
- `shared/` - Common utilities and types

## Tool Execution Architecture

**LLM Proxy** returns tool calls to clients for execution (standard OpenAI/Anthropic behavior). Clients implement the agentic loop:
1. Call LLM proxy → receive tool_use/tool_calls
2. Execute tools via MCP Gateway (`POST /v1/mcp` with `Bearer ${agentId}`)
3. Send tool results back to LLM proxy
4. Receive final answer

Tool invocation policies and trusted data policies are still enforced by the proxy.

## Authentication

- **Better-Auth**: Session management with dynamic RBAC
- **API Key Auth**: `Authorization: ${apiKey}` header (not Bearer)
- **Custom Roles**: Up to 50 custom roles per organization
- **Middleware**: Fastify plugin at `backend/src/auth/fastify-plugin/`
- **Route Permissions**: Configure in `shared/access-control.ts`
- **Request Context**: `request.user` and `request.organizationId`
- **Schema Files**: Auth schemas in separate files: `account`, `api-key`, `invitation`, `member`, `session`, `two-factor`, `verification`

## Observability

**Tracing**: LLM proxy routes add agent data via `startActiveLlmSpan()`. Traces include `agent.id`, `agent.name` and dynamic `agent.<label>` attributes. Agent label keys are fetched from database on startup and included as resource attributes. Traces stored in Grafana Tempo.

**Metrics**: Prometheus metrics (`llm_request_duration_seconds`, `llm_tokens_total`) include `agent_name`, `agent_id` and dynamic agent labels as dimensions. Metrics are reinitialized on startup with current label keys from database.

**Local Setup**: Use `tilt trigger observability` or `docker compose -f dev/docker-compose.observability.yml up` to start Tempo, Prometheus, and Grafana with pre-configured datasources.

## Coding Conventions

**Database Architecture Guidelines**:

- **Model-Only Database Access**: All database queries MUST go through `backend/src/models/` - never directly in routes or services
- **Model Creation**: Create model files for any new database entities you need to interact with
- **CRUD Centralization**: Models should handle all CRUD operations and complex queries
- **No Business Logic**: Keep models focused on data access, business logic goes in services

**Frontend**:

- Use TanStack Query for data fetching
- Use shadcn/ui components only
- Small focused components with extracted business logic
- Flat file structure, avoid barrel files
- Only export what's needed externally
- **API Client Guidelines**: Frontend `.query.ts` files should NEVER use `fetch()` directly - always run `pnpm codegen:api-client` first to ensure SDK is up-to-date, then use the generated SDK methods instead of manual API calls for type safety and consistency

**Backend**:

- Use Drizzle ORM for database operations through MODELS ONLY!
- Table exports: Use plural names with "Table" suffix (e.g., `agentLabelsTable`, `sessionsTable`)
- Colocate test files with source (`.test.ts`)
- Flat file structure, avoid barrel files
- Route permissions: Add to `requiredEndpointPermissionsMap` in `shared/access-control.ts`
- Only export public APIs
- Use the `logger` instance from `@/logging` for all logging (replaces console.log/error/warn/info)
- **Backend Testing Best Practices**: Never mock database interfaces in backend tests - use the existing `backend/src/test/setup.ts` PGlite setup for real database testing, and use model methods to create/manipulate test data for integration-focused testing

**Team-based Access Control**:

- Agents and MCP servers use team-based authorization
- Teams managed via better-auth organization plugin
- Junction tables: `agent_team` and `mcp_server_team`
- Breaking change: `usersWithAccess[]` replaced with `teams[]`
- Admin-only team CRUD via `/api/teams/*`
- Members can read teams and access assigned resources

**Custom RBAC Roles**:

- Extends predefined roles (admin, member)
- Up to 50 custom roles per organization
- 30 resources across 4 categories with CRUD permissions
- Permission validation: can only grant what you have
- Predefined roles are immutable
- API: `/api/roles/*` (GET, POST, PUT, DELETE)
- Database: `organizationRolesTable`
- UI: Admin-only roles management at `/settings/roles`

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

- Local MCP servers run in K8s pods (one pod per server) when K8s is configured
- Feature flag `orchestrator-k8s-runtime` returned by `/api/features` endpoint
- Feature enabled when EITHER ARCHESTRA_ORCHESTRATOR_KUBECONFIG or ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER is configured
- Frontend disables local MCP server functionality when feature is off (shows tooltip explaining orchestrator-k8s-runtime requirement)
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
- Service type: Configurable via `archestra.service.type`, NodePort support with fixed ports
- Health probes: Startup (5min), liveness, readiness probes on frontend port
- Optional Ingress: Enable with `archestra.ingress.enabled`, supports custom hosts, paths, TLS, annotations, or full spec override
- Secret-based env vars via `archestra.envFromSecrets` for sensitive data injection (e.g., API keys from K8s Secrets)
- Bulk env var import via `archestra.envFrom` for importing all keys from Secrets/ConfigMaps at once

**White-labeling**:

- Custom logos: PNG only, max 2MB, stored as base64
- 5 fonts: Lato, Inter, Open Sans, Roboto, Source Sans Pro
- Real-time theme and font preview in settings
- Custom logos display with "Powered by Archestra" attribution
- Database columns: theme, customFont, logo

**Chat Feature**:

- Agent-based conversations: Each conversation is tied to a specific agent
- Agent selection via dropdown: Users select an agent when creating a new conversation
- MCP tool integration: Chat automatically uses the agent's assigned MCP tools via MCP Gateway
- LLM Proxy integration: Chat routes through LLM Proxy (`/v1/anthropic/${agentId}`) for security policies, dual LLM, and observability
- Agent authentication: Connects to internal MCP Gateway using `Authorization: Bearer ${agentId}`
- Database schema: Conversations table includes `agentId` foreign key to agents table
- UI components: `AgentSelector` dropdown, `ConversationList` with agent badges
- Tool execution: Routes through MCP Gateway, includes response modifiers and logging
- No manual configuration: Deprecated `ARCHESTRA_CHAT_MCP_SERVER_URL` and `ARCHESTRA_CHAT_MCP_SERVER_HEADERS`
- Required env var: `ARCHESTRA_CHAT_ANTHROPIC_API_KEY` (used by LLM Proxy for Anthropic calls)

**Archestra MCP Server**:

- Built-in tools automatically injected into all agents
- Tools prefixed with `archestra__` to avoid conflicts
- Available tools:
  - `archestra__whoami`: Returns agent name and ID
  - `archestra__search_private_mcp_registry`: Search internal MCP catalog
  - `archestra__create_agent`: Create new agents with optional teams and labels
  - `archestra__create_limit`: Create cost/usage limits for organization, team, or agent
  - `archestra__get_limits`: Retrieve limits with optional filtering
  - `archestra__update_limit`: Update existing limit values
  - `archestra__delete_limit`: Delete limits by ID
  - `archestra__get_agent_token_usage`: Get total token usage statistics for agents
- Planned tool (temporarily disabled):
  - `archestra__create_mcp_server_installation_request`: Request MCP server installation (disabled pending user context availability)
- Implementation: `backend/src/archestra-mcp-server.ts`

**Testing**:

- **Backend**: Vitest with PGLite for in-memory PostgreSQL testing - never mock database interfaces, use real database operations via models for comprehensive integration testing
- **E2E Tests**: Playwright with test fixtures pattern - import from `./fixtures` in API/UI test directories
- **E2E Test Fixtures**: 
  - API fixtures: `makeApiRequest`, `createAgent`, `deleteAgent`, `createApiKey`, `deleteApiKey`, `createToolInvocationPolicy`, `deleteToolInvocationPolicy`, `createTrustedDataPolicy`, `deleteTrustedDataPolicy`
  - UI fixtures: `goToPage`, `makeRandomString`
- **Backend Test Fixtures**: Import from `@/test` to access Vitest context with fixture functions. Available fixtures: `makeUser`, `makeAdmin`, `makeOrganization`, `makeTeam`, `makeAgent`, `makeTool`, `makeAgentTool`, `makeToolPolicy`, `makeTrustedDataPolicy`, `makeCustomRole`, `makeMember`, `makeMcpServer`, `makeInternalMcpCatalog`, `makeInvitation`

**Backend Test Fixtures Usage**:
```typescript
import { test, expect } from "@/test";

test("example test", async ({ makeUser, makeOrganization, makeTeam }) => {
  const user = await makeUser({ email: "custom@test.com" });
  const org = await makeOrganization();
  const team = await makeTeam(org.id, user.id, { name: "Custom Team" });
  // test logic...
});
```

**E2E Test Fixtures Usage**:
```typescript
import { test } from "./fixtures";

test("API example", async ({ request, createAgent, deleteAgent }) => {
  const response = await createAgent(request, "Test Agent");
  const agent = await response.json();
  // test logic...
  await deleteAgent(request, agent.id);
});
```
- never amend commits