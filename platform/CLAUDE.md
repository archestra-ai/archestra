# Individual Preferences

- @CLAUDE_LOCAL.md

## Working Directory

**ALWAYS run all commands from the `platform/` directory unless specifically instructed otherwise.**

## Important Rules

1. **Use pnpm** for package management
2. **Use Biome for formatting and linting** - Run `pnpm lint` before committing
3. **TypeScript strict mode** - Ensure code passes `pnpm type-check` before completion
4. **Use Tilt for development** - `tilt up` to start the full environment
5. **Use shadcn/ui components** - Add with `npx shadcn@latest add <component>`
6. **Documentation Updates** - For any feature or system changes, audit `../docs/pages` to determine if existing content needs modification/updates or if new documentation should be added. Follow the writing guidelines in `../docs/docs_writer_prompt.md`
7. **Always Add Tests** - When working on any feature, ALWAYS add or modify appropriate test cases (unit tests, integration tests, or e2e tests under `platform/e2e-tests/tests`)
8. **Enterprise Edition Imports** - NEVER directly import from `.ee.ts` files unless the importing file is itself an `.ee.ts` file. Use runtime conditional logic with `config.enterpriseLicenseActivated` checks instead to avoid bundling enterprise code into free builds

## Docs

Docs are stored at ./docs
Check ./docs/docs_writer_prompt.md before changing docs files.

## Key URLs

- **Frontend**: <http://localhost:3000/>
- **Backend**: <http://localhost:9000/> (Fastify API server)
- **Chat**: <http://localhost:3000/chat> (n8n expert chat with MCP tools, conversations in main sidebar)
- **Tools**: <http://localhost:3000/tools> (Unified tools management with server-side pagination)
- **Settings**: <http://localhost:3000/settings> (Main settings page with tabs for LLM & MCP Gateways, Dual LLM, Your Account, Members, Teams, Appearance)
- **Appearance Settings**: <http://localhost:3000/settings/appearance> (Admin-only: customize theme, logo, fonts)
- **MCP Catalog**: <http://localhost:3000/mcp-catalog> (Install and manage MCP servers)
- **MCP Installation Requests**: <http://localhost:3000/mcp-catalog/installation-requests> (View/manage server installation requests)
- **LLM Proxy Logs**: <http://localhost:3000/logs/llm-proxy> (View LLM proxy request logs)
- **MCP Gateway Logs**: <http://localhost:3000/logs/mcp-gateway> (View MCP tool call logs)
- **Roles**: <http://localhost:3000/settings/roles> (Admin-only: manage custom RBAC roles)
- **Cost**: <http://localhost:3000/cost> (Redirects to /cost/statistics)
- **Cost Statistics**: <http://localhost:3000/cost/statistics> (Usage analytics with time series charts and custom date ranges)
- **Cost Limits**: <http://localhost:3000/cost/limits> (Token usage limits management with per-profile configuration)
- **Token Price**: <http://localhost:3000/cost/token-price> (Model pricing configuration)
- **Optimization Rules**: <http://localhost:3000/cost/optimization-rules> (Cost optimization policies)
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
- **Profile Tools API**: <http://localhost:9000/api/profile-tools> (GET paginated profile-tool relationships with filtering/sorting)

## Common Commands

```bash
# Development
tilt up                                 # Start full development environment
pnpm dev                                # Start all workspaces
pnpm lint                               # Lint and auto-fix
pnpm type-check                         # Check TypeScript types
pnpm test                               # Run tests
pnpm test:e2e                           # Run e2e tests with Playwright (chromium, webkit, firefox)

# Dependency Management
pnpm install                            # Install dependencies (scripts disabled for security)
pnpm rebuild <package-name>             # Run install scripts for specific package when needed
pnpm rebuild                            # Run install scripts for all packages (rarely needed)

# Database
pnpm db:migrate      # Run database migrations
pnpm db:studio       # Open Drizzle Studio
pnpm db:generate     # Generate new migrations (CI checks for uncommitted migrations)
drizzle-kit check    # Check consistency of generated SQL migrations history

# Database Connection
# PostgreSQL is running in Kubernetes (managed by Tilt)
# Connect to database:
kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password psql -U archestra -d archestra_dev

# Common queries: \dt (list tables), \d table_name (describe table), SELECT COUNT(*) FROM drizzle.__drizzle_migrations;

# Logs
tilt logs pnpm-dev                   # Get logs for frontend + backend
tilt trigger <pnpm-dev|wiremock|etc> # Trigger an update for the specified resource

# E2E setup
Runs wiremock and seeds test data to database. Note that in development e2e use your development database. This means some of your local data may cause e2e to fail locally.
tilt trigger e2e-test-dependencies   # Start e2e WireMock

Check wiremock health at:
http://localhost:9092/__admin/health

ARCHESTRA_OPENAI_BASE_URL=http://localhost:9092/v1
ARCHESTRA_ANTHROPIC_BASE_URL=http://localhost:9092
ARCHESTRA_GEMINI_BASE_URL=http://localhost:9092

# Orlando WireMock (project-specific)
tilt trigger orlando-wiremock 

ARCHESTRA_OPENAI_BASE_URL=http://localhost:9091/v1
ARCHESTRA_ANTHROPIC_BASE_URL=http://localhost:9091
ARCHESTRA_GEMINI_BASE_URL=http://localhost:9091

# E2E Testing
pnpm test:e2e                        # Run Playwright tests
# Local: docker-compose setup (Tiltfile.test)
# CI: kind cluster + helm deployment
#   - kind config: .github/kind.yaml
#   - helm values: .github/values-ci.yaml
#   - NodePort services: frontend:3000, backend:9000, metrics:9050
#   - CI checks in e2e job: drizzle-kit check, codegen, db migrations

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

# LLM Proxy Route Selection (optional)
ARCHESTRA_OPENAI_USE_V2_ROUTES=false  # Set to true to use unified V2 OpenAI routes instead of legacy V1 handler
ARCHESTRA_ANTHROPIC_USE_V2_ROUTES=false  # Set to true to use unified V2 Anthropic routes instead of legacy V1 handler

# Analytics (optional - disabled for local dev and e2e tests)
ARCHESTRA_ANALYTICS=disabled  # Set to "disabled" to disable PostHog analytics

# Authentication Secret (REQUIRED, must be at least 32 characters)
# Generate with: openssl rand -base64 32
# In Helm: Auto-generated on first install and persisted
# In Docker: Auto-generated and saved to /app/data/.auth_secret
# For local dev: Must be set manually in .env file
ARCHESTRA_AUTH_SECRET=auth-secret-must-be-at-least-32-chars-long

# Disable Basic Authentication (username/password login form)
ARCHESTRA_AUTH_DISABLE_BASIC_AUTH=false  # Set to true to hide login form and require SSO
ARCHESTRA_AUTH_DISABLE_INVITATIONS=false  # Set to true to disable user invitations

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

# Secrets Manager Configuration
ARCHESTRA_SECRETS_MANAGER=DB  # Options: DB (default), Vault, READONLY_VAULT
ARCHESTRA_HASHICORP_VAULT_ADDR=http://localhost:8200  # Required when ARCHESTRA_SECRETS_MANAGER=Vault or READONLY_VAULT
ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=TOKEN  # Options: "TOKEN" (default), "K8S", or "AWS"
ARCHESTRA_HASHICORP_VAULT_KV_VERSION=2  # Options: "1" or "2" (default: "2") - KV secrets engine version

# Vault Token Authentication (ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=TOKEN or not set)
ARCHESTRA_HASHICORP_VAULT_TOKEN=dev-root-token  # Required for TOKEN auth

# Vault Kubernetes Authentication (ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=K8S)
ARCHESTRA_HASHICORP_VAULT_K8S_ROLE=  # Required for K8S auth: Vault role bound to K8s service account
ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH=  # Optional: Path to SA token (default: /var/run/secrets/kubernetes.io/serviceaccount/token)
ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT=  # Optional: Vault K8S auth mount point (default: kubernetes)
ARCHESTRA_HASHICORP_VAULT_SECRET_PATH=  # Optional: Path prefix for secrets (default: "secret/data/archestra" for v2, "secret/archestra" for v1)
ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH=  # Optional: Path prefix for secret metadata in Vault KV v2 (default: secretPath with /data/ replaced by /metadata/)

# Vault AWS IAM Authentication (ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=AWS)
ARCHESTRA_HASHICORP_VAULT_AWS_ROLE=  # Required for AWS auth: Vault role bound to AWS IAM principal
ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT=  # Optional: Vault AWS auth mount point (default: aws)
ARCHESTRA_HASHICORP_VAULT_AWS_REGION=  # Optional: AWS region for STS signing (default: us-east-1)
ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT=  # Optional: STS endpoint URL (default: https://sts.amazonaws.com, matches Vault's default)
ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID=  # Optional: Value for X-Vault-AWS-IAM-Server-ID header (additional security)

# Sentry Error Tracking (optional - leave empty to disable)
ARCHESTRA_SENTRY_BACKEND_DSN=  # Backend error tracking DSN
ARCHESTRA_SENTRY_FRONTEND_DSN=  # Frontend error tracking DSN
```

## Architecture

**Tech Stack**: pnpm monorepo, Fastify backend (port 9000), metrics server (port 9050), Next.js frontend (port 3000), PostgreSQL + Drizzle ORM, Biome linting, Tilt orchestration, Kubernetes for MCP server runtime

**Key Features**: MCP tool execution, dual LLM security pattern, tool invocation policies, trusted data policies, MCP response modifiers (Handlebars.js), team-based access control (profiles and MCP servers), MCP server installation request workflow, K8s-based MCP server runtime with stdio and streamable-http transport support, white-labeling (themes, logos, fonts), profile-based chat with MCP tools, comprehensive built-in Archestra MCP tools, profile chat visibility control, TOON format conversion for efficient token usage

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

**Tracing**: LLM proxy routes add profile data via `startActiveLlmSpan()`. Traces include `agent.id`, `agent.name` and dynamic `agent.<label>` attributes. Profile label keys are fetched from database on startup and included as resource attributes. Traces stored in Grafana Tempo.

**Metrics**: Prometheus metrics (`llm_request_duration_seconds`, `llm_tokens_total`) include `agent_name`, `agent_id` and dynamic profile labels as dimensions. Metrics are reinitialized on startup with current label keys from database.

**Local Setup**: Use `tilt trigger observability` or `docker compose -f dev/docker-compose.observability.yml up` to start Tempo, Prometheus, and Grafana with pre-configured datasources.

## Dependency Security

**Install Script Protection**: The platform disables automatic execution of install scripts via `ignore-scripts=true` in `.npmrc` to prevent supply chain attacks. Install scripts (`preinstall`, `postinstall`, `install`) can execute arbitrary code, steal secrets, and compromise the system.

**Minimum Release Age**: Packages must be published for at least 7 days before installation (`minimum-release-age=10080` minutes in `.npmrc`). This allows time for community detection and removal of malicious releases, which are typically caught within hours.

**Working with Disabled Scripts**: Most packages work without install scripts. When needed, manually rebuild specific packages:

```bash
pnpm rebuild <package-name>  # Enable scripts for specific package
```

**Dependency Updates**: Before updating dependencies, review what scripts will run (`npm view <package> scripts`), check release dates, and wait 7 days for new releases of critical packages to allow community security review. Always review `pnpm-lock.yaml` changes in PRs.

## Coding Conventions

**General**:

- **Function Parameters**: If a function accepts more than 2 parameters, use a single object parameter instead of multiple positional parameters. This improves readability, makes parameters self-documenting, and allows for easier future extension.
  ```typescript
  // Good
  async function validateScope(params: {
    scope: string;
    teamId: string | null;
    userId: string;
  }): Promise<void> { ... }

  // Avoid
  async function validateScope(
    scope: string,
    teamId: string | null,
    userId: string
  ): Promise<void> { ... }
  ```

**Database Architecture Guidelines**:

- **Model-Only Database Access**: All database queries MUST go through `backend/src/models/` - never directly in routes or services
- **Model Creation**: Create model files for any new database entities you need to interact with
- **CRUD Centralization**: Models should handle all CRUD operations and complex queries
- **No Business Logic**: Keep models focused on data access, business logic goes in services
- **N+1 Query Prevention**: When fetching lists with related data, use batch loading methods (e.g., `getTeamsForAgents()`) instead of individual queries per item

**Frontend**:

- Use TanStack Query for data fetching
- Use shadcn/ui components only
- **Use components from `frontend/src/components/ui` over plain HTML elements**: Never use raw `<button>`, `<input>`, `<select>`, etc. when a component exists in `frontend/src/components/ui` (Button over button, Input over input, etc.)
- **Handle toasts in .query.ts files, not in components**: Toast notifications for mutations (success/error) should be defined in the mutation's `onSuccess`/`onError` callbacks within `.query.ts` files, not in components
- Small focused components with extracted business logic
- Flat file structure, avoid barrel files
- Only export what's needed externally
- **API Client Guidelines**: Frontend `.query.ts` files should NEVER use `fetch()` directly - always run `pnpm codegen:api-client` first to ensure SDK is up-to-date, then use the generated SDK methods instead of manual API calls for type safety and consistency
- **Prefer TanStack Query over prop drilling**: When a component needs data that's available via a TanStack Query hook, use the hook directly in that component rather than fetching in a parent and passing via props. TanStack Query's built-in caching ensures no duplicate requests. Only pass minimal identifiers (like `catalogId`) needed for the component to fetch/filter its own data.
- **Use react-hook-form for forms**: Prefer `useForm` over multiple `useState` hooks for form state management. Pass form objects to child components via `form: UseFormReturn<FormValues>` prop rather than individual state setters. Parent components handle mutations and submission, form components focus on rendering.
- **Reuse API types from @shared**: Use types from `archestraApiTypes` (e.g., `archestraApiTypes.CreateXxxData["body"]`, `archestraApiTypes.GetXxxResponses["200"]`) instead of defining duplicate types. Import from `@shared`.

**Backend**:

- Use Drizzle ORM for database operations through MODELS ONLY!
- Table exports: Use plural names with "Table" suffix (e.g., `profileLabelsTable`, `sessionsTable`)
- Colocate test files with source (`.test.ts`)
- Flat file structure, avoid barrel files
- Route permissions: Add to `requiredEndpointPermissionsMap` in `shared/access-control.ee.ts`
- Only export public APIs
- Use the `logger` instance from `@/logging` for all logging (replaces console.log/error/warn/info)
- **Backend Testing Best Practices**: Never mock database interfaces in backend tests - use the existing `backend/src/test/setup.ts` PGlite setup for real database testing, and use model methods to create/manipulate test data for integration-focused testing
- **API Response Standardization**: Use `constructResponseSchema` helper for all routes to ensure consistent error responses (400, 401, 403, 404, 500)
- **Error Handling**: Throw `ApiError` instances with appropriate status codes - handled centrally by Fastify error handler
- **Type Organization**: Keep database schemas in `database/schemas/`, extract business types to dedicated `types/` files
- **Pagination**: Use `PaginationQuerySchema` and `createPaginatedResponseSchema` for consistent pagination across APIs
- **Sorting**: Use `SortingQuerySchema` or `createSortingQuerySchema` for standardized sorting parameters

**Team-based Access Control**:

- Profiles and MCP servers use team-based authorization
- Teams managed via better-auth organization plugin
- Junction tables: `profile_team` and `mcp_server_team`
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

**Profile Labels**:

- Profiles support key-value labels for organization/categorization
- Database schema: `label_keys`, `label_values`, `profile_labels` tables
- Keys and values stored separately for consistency and reuse
- One value per key per profile (updating same key replaces value)
- Labels returned in alphabetical order by key for consistency
- API endpoints: GET `/api/profiles/labels/keys`, GET `/api/profiles/labels/values?key=<key>` (key param filters values by key)

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

**TOON Format Conversion**:

- Profiles support optional TOON (Token-Oriented Object Notation) conversion for tool results
- Reduces token usage by 30-60% for uniform arrays of objects
- Enabled via `convert_tool_results_to_toon` boolean field on profiles
- Automatically converts JSON tool results to TOON format before sending to LLM
- Particularly useful for profiles dealing with structured data from database or API tools

**Chat Feature**:

- Profile-based conversations: Each conversation is tied to a specific profile
- Profile selection via dropdown: Users select a profile when creating a new conversation
- All profiles enabled for chat: All profiles are available in chat by default (the `use_in_chat` field is deprecated)
- MCP tool integration: Chat automatically uses the profile's assigned MCP tools via MCP Gateway
- LLM Proxy integration: Chat routes through LLM Proxy (`/v1/anthropic/${agentId}`) for security policies, dual LLM, and observability
- Profile authentication: Connects to internal MCP Gateway using `Authorization: Bearer ${agentId}`
- Database schema: Conversations table includes `agentId` foreign key to agents table
- UI components: `AgentSelector` dropdown, `ChatSidebarSection` for conversation navigation in main sidebar
- Conversation navigation: Recent chats shown as sub-items under "Chat" menu in main sidebar (ChatSidebarSection component)
- Hide tool calls toggle: Located in chat messages header, persisted in localStorage
- Conversation management: Select, edit (inline rename), delete conversations directly in sidebar sub-navigation
- Smart visibility: Shows first 10 conversations by default with "Show N more" toggle for better UX when many conversations exist
- Full-width chat interface: Chat page uses entire width without separate conversation sidebar
- Tool execution: Routes through MCP Gateway, includes response modifiers and logging
- No manual configuration: Deprecated `ARCHESTRA_CHAT_MCP_SERVER_URL` and `ARCHESTRA_CHAT_MCP_SERVER_HEADERS`
- Required env var: `ARCHESTRA_CHAT_ANTHROPIC_API_KEY` (used by LLM Proxy for Anthropic calls)

**Archestra MCP Server**:

- Built-in tools automatically injected into all profiles
- Tools prefixed with `archestra__` to avoid conflicts
- Available tools:
  - Profile management: `whoami`, `create_profile`, `get_profile`
  - Limits: `create_limit`, `get_limits`, `update_limit`, `delete_limit`, `get_profile_token_usage`
  - Policies: `get/create/update/delete_tool_invocation_policy`, `get/create/update/delete_trusted_data_policy`
  - MCP servers: `search_private_mcp_registry`, `get_mcp_servers`, `get_mcp_server_tools`
  - Tool assignment: `bulk_assign_tools_to_profiles`
  - Operators: `get_autonomy_policy_operators`
- Implementation: `backend/src/archestra-mcp-server.ts`
- Note: `create_mcp_server_installation_request` temporarily disabled pending user context support
- Security: Archestra tools are always trusted and bypass tool invocation/trusted data policies
- UI: Hidden from tools management interface (use `excludeArchestraTools: true` query param)

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

**Playwright Locator Best Practices**:

Prefer Playwright's recommended locators over raw `locator()` calls. In priority order:
1. `page.getByRole()` - Accessible elements by ARIA role (buttons, links, headings, etc.)
2. `page.getByText()` - Find by text content
3. `page.getByLabel()` - Form controls by label
4. `page.getByPlaceholder()` - Input elements by placeholder
5. `page.getByTestId()` - Custom test IDs (use `E2eTestId` constants from `@shared`)

Avoid:
- Raw CSS selectors: `page.locator('.my-class')` or `page.locator('#my-id')`
- XPath selectors
- Arbitrary timeouts - use Playwright's auto-waiting instead

Example:
```typescript
// Good
await page.getByRole("button", { name: /Submit/i }).click();
await page.getByLabel(/Email/i).fill("test@example.com");
await page.getByTestId(E2eTestId.CreateAgentButton).click();

// Avoid
await page.locator('.submit-btn').click();
await page.locator('#email-input').fill("test@example.com");
await page.waitForTimeout(1000); // Use auto-waiting instead
```

Reference: https://playwright.dev/docs/locators#quick-guide

- never amend commits
