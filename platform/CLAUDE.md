# Individual Preferences

- @CLAUDE_LOCAL.md

## Working Directory

**ALWAYS run all commands from the `platform/` directory unless specifically instructed otherwise.**

## Important Rules

1. **Use pnpm** for package management
2. **Use Tilt for development** - `tilt up` to start the full environment
3. **Use shadcn/ui components** - Add with `npx shadcn@latest add <component>`
4. **Documentation Updates** - For any feature or system changes, audit `../docs/pages` to determine if existing content needs modification/updates or if new documentation should be added. Follow the writing guidelines in `../docs/docs_writer_prompt.md`
5. **Always Add Tests** - When working on any feature, ALWAYS add or modify appropriate test cases (unit tests, integration tests, or e2e tests under `platform/e2e-tests/tests`)
6. **Enterprise Edition Imports** - NEVER directly import from `.ee.ts` files unless the importing file is itself an `.ee.ts` file. Use runtime conditional logic with `config.enterpriseFeatures.core` checks instead to avoid bundling enterprise code into free builds
7. **No Auto Commits** - Never commit or push changes without explicit user approval. Always ask before running git commit or git push
8. **No Database Modifications Without Approval** - NEVER run INSERT, UPDATE, DELETE, or any data-modifying SQL queries without explicit user approval. SELECT queries for reading data are allowed. Always ask before modifying database data directly.
9. **NEVER MENTION REAL CUSTOMER NAMES OR IDENTIFIERS ANYWHERE IN CODE, COMMENTS, TESTS, DOCS, COMMITS, OR PR TEXT!!!!!!!!!!**
10. **Never copy anything from Sentry into code, comments, tests, docs, commits, or PR text — and do not mention Sentry itself.** Sentry is for diagnosing the problem; describe the bug in neutral terms and cite no IDs, environments, URLs, user info, or stack snippets from there.

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
- **MCP Registry**: <http://localhost:3000/mcp/registry> (Install and manage MCP servers)
- **MCP Installation Requests**: <http://localhost:3000/mcp/registry/installation-requests> (View/manage server installation requests)
- **LLM Proxy Logs**: <http://localhost:3000/llm/logs> (View LLM proxy request logs)
- **MCP Gateway Logs**: <http://localhost:3000/mcp/logs> (View MCP tool call logs)
- **Roles**: <http://localhost:3000/settings/roles> (Admin-only: manage custom RBAC roles)
- **Cost Statistics**: <http://localhost:3000/llm/cost/statistics> (Usage analytics with time series charts and custom date ranges)
- **Cost Limits**: <http://localhost:3000/llm/cost/limits> (Token usage limits management with per-profile configuration)
- **Token Price**: <http://localhost:3000/llm/cost/token-price> (Model pricing configuration)
- **Optimization Rules**: <http://localhost:3000/llm/cost/optimization-rules> (Cost optimization policies)
- **Tilt UI**: <http://localhost:10350/>
- **Drizzle Studio**: <https://local.drizzle.studio/>
- **MCP Gateway**: <http://localhost:9000/v1/mcp/:profileId> (GET for discovery, POST for JSON-RPC stateless mode, requires Bearer archestra_token auth)
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

# Manual Migrations with Data Migration Logic
# When creating migrations that include data migration (INSERT/UPDATE statements),
# you must use the Drizzle-generated migration file name to ensure proper tracking:
# 1. First, update the Drizzle schema files with your schema changes
# 2. Run `pnpm db:generate` - this creates a migration with a random name (e.g., 0119_military_alice.sql)
# 3. Add your data migration SQL to the generated file (INSERT, UPDATE statements, etc.)
# 4. Run `drizzle-kit check` to verify consistency
# IMPORTANT: Never create manually-named migration files - Drizzle tracks migrations
# via the meta/_journal.json file which references the generated file names.

# Custom Data-Only Migrations (no schema changes)
# For pure data migrations (UPDATE, INSERT) with no schema changes, use:
#   cd backend && npx drizzle-kit generate --custom --name=<descriptive-name>
# This creates an empty SQL file tracked by Drizzle's journal. Add your SQL, then run:
#   npx drizzle-kit check

# Database Connection
# PostgreSQL is running in Kubernetes (managed by Tilt)
# Connect to database:
kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password psql -U archestra -d archestra_dev

# Common queries: \dt (list tables), \d table_name (describe table), SELECT COUNT(*) FROM drizzle.__drizzle_migrations;

# Logs
tilt logs pnpm-dev-backend           # Get backend logs
tilt logs pnpm-dev-frontend          # Get frontend logs
tilt trigger <pnpm-dev-backend|pnpm-dev-frontend|wiremock|etc> # Trigger an update for the specified resource

# E2E setup
Runs wiremock and seeds test data to database. Note that in development e2e use your development database. This means some of your local data may cause e2e to fail locally.
tilt trigger e2e-test-dependencies   # Start e2e WireMock

Check wiremock health at:
http://localhost:9092/__admin/health

ARCHESTRA_OPENAI_BASE_URL=http://localhost:9092/v1
ARCHESTRA_ANTHROPIC_BASE_URL=http://localhost:9092
ARCHESTRA_GEMINI_BASE_URL=http://localhost:9092

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

**Naming Convention**: All env vars MUST follow the pattern `ARCHESTRA_<PRODUCT_AREA>_<THING>` (e.g., `ARCHESTRA_LLM_PROXY_MAX_VIRTUAL_KEYS`, `ARCHESTRA_OTEL_VERBOSE_TRACING`).

**Adding New Env Vars**:

1. **Consume in `backend/src/config.ts`** - Parse and validate the env var here. If a custom parse/validation function is needed, export it and add tests in `backend/src/config.test.ts`
2. **Document in `../docs/pages/platform-deployment.md`** - All new env vars MUST be documented in the Environment Variables section. Use best judgement on whether it warrants a new subsection
3. **Frontend access via `/api/config`** - If the frontend needs to reference an env var value, expose it through `backend/src/routes/config.ts` response and consume via the `useFeature()` hook

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
2. Execute tools via MCP Gateway (`POST /v1/mcp/${profileId}` with `Bearer ${archestraToken}`)
3. Send tool results back to LLM proxy
4. Receive final answer

Tool invocation policies and trusted data policies are still enforced by the proxy.

## Authentication

- **Better-Auth**: Session management with dynamic RBAC
- **API Key Auth**: `Authorization: ${apiKey}` header (not Bearer)
- **Custom Roles**: Unlimited custom roles per organization
- **Middleware**: Fastify plugin at `backend/src/auth/fastify-plugin/`
- **Route Permissions**: Configure in `shared/access-control.ts`
- **Request Context**: `request.user` and `request.organizationId`
- **Schema Files**: Auth schemas in separate files: `account`, `api-key`, `invitation`, `member`, `session`, `two-factor`, `verification`

## Observability

**Tracing**: Follows [OTEL GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/). LLM spans use `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.operation.name`, and `archestra.label.<key>` for dynamic labels. MCP spans use `gen_ai.tool.name`, `mcp.server.name`. Session tracking via `gen_ai.conversation.id` (from `X-Archestra-Session-Id` header). Span names: `chat {model}`, `generate_content {model}`, `execute_tool {tool_name}`. Agent label keys fetched from database on startup and included as resource attributes. Traces stored in Grafana Tempo. User identity tracked via `archestra.user.id`, `archestra.user.email`, `archestra.user.name` (when available). LLM spans include `archestra.cost` (USD) and `gen_ai.usage.total_tokens`.

**Metrics**: Prometheus metrics (`llm_request_duration_seconds`, `llm_tokens_total`) include `agent_id` (internal), `agent_name`, `agent_type`, `external_agent_id` (from header), and dynamic agent labels as dimensions. MCP metrics include `agent_id`, `agent_name`, `agent_type`. Agent execution metrics use `external_agent_id` for the client-provided ID. Metrics are reinitialized on startup with current label keys from database.

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

- **Prefer Classes for Stateful Modules**: When encapsulating functionality that involves state (cached values, intervals, connections, etc.), prefer creating a class over standalone module functions. Export a singleton instance. This improves encapsulation, testability, and makes state management explicit.
- **Use Shared Cache Utilities**: Do not introduce custom cache implementations with ad hoc `Map`s, manual TTLs, or hand-rolled eviction. Use one of the existing cache primitives in `backend/src/cache-manager.ts` (`cacheManager` or `LRUCacheManager`) unless there is a documented reason not to.

  ```typescript
  // Good - class with singleton
  class ChatOpsManager {
    private provider: Provider | null = null;

    initialize() { ... }
    cleanup() { ... }
  }
  export const chatOpsManager = new ChatOpsManager();

  // Avoid - module-level state with loose functions
  let provider: Provider | null = null;
  export function initialize() { ... }
  export function cleanup() { ... }
  ```

- **Private Methods at Bottom**: In classes, mark methods as `private` if they are only used within the class. Place all private methods at the bottom of the class, after public methods. This keeps the "public interface" visible at the top.

  ```typescript
  class MyService {
    // Public methods first
    doSomething() {
      this.helperA();
    }

    // Private methods at bottom
    private helperA() { ... }
    private helperB() { ... }
  }
  ```

- **No Premature Exports**: Only export what is actually used outside the module. If a function, constant, or type is only used within the module, do NOT export it. This is critical for maintaining clean module boundaries.

  ```typescript
  // Good - only export what's needed externally
  export const myService = new MyService();

  // Bad - exporting internal helpers "just in case"
  export function internalHelper() { ... }  // Not used outside!
  export const INTERNAL_CONSTANT = 42;      // Not used outside!
  ```

- **Module Code Order**: Structure modules so the "public interface" appears at the top. Internal/private functions and constants should be placed at the bottom of the file. This makes it immediately clear what the module exposes.

  ```typescript
  // 1. Imports
  import { something } from "somewhere";

  // 2. Exported items (public interface) - at TOP
  export function publicFunctionA() {
    return helperB();
  }

  export const publicConstant = "value";

  // 3. Internal helpers - at BOTTOM
  function helperB() {
    return helperC();
  }

  function helperC() {
    return INTERNAL_CONFIG.value;
  }

  const INTERNAL_CONFIG = { value: 42 };
  ```

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

- Use TanStack Query for data fetching (prefer `useQuery` over `useSuspenseQuery` with explicit loading states)
- Use shadcn/ui components only
- **Use components from `frontend/src/components/ui` over plain HTML elements**: Never use raw `<button>`, `<input>`, `<select>`, etc. when a component exists in `frontend/src/components/ui` (Button over button, Input over input, etc.)
- **Do not hardcode `Archestra` in frontend UI copy**: Use `const appName = useAppName();` and interpolate the app name so white-labeled deployments render correctly
- **Handle toasts in .query.ts files, not in components**: Toast notifications for mutations (success/error) should be defined in the mutation's `onSuccess`/`onError` callbacks within `.query.ts` files, not in components
- **Never throw on HTTP errors**: In query/mutation functions, never throw errors on HTTP failures. Use `handleApiError(error)` for user notification and return appropriate default values (`null`, `[]`, `{}`). Components should not have try/catch for API calls - all error handling belongs in `.query.ts` files.
- Small focused components with extracted business logic
- Flat file structure, avoid barrel files
- Only export what's needed externally
- **API Client Guidelines**: Frontend `.query.ts` files should NEVER use `fetch()` directly - always run `pnpm codegen:api-client` first to ensure SDK is up-to-date, then use the generated SDK methods instead of manual API calls for type safety and consistency
- **Prefer TanStack Query over prop drilling**: When a component needs data that's available via a TanStack Query hook, use the hook directly in that component rather than fetching in a parent and passing via props. TanStack Query's built-in caching ensures no duplicate requests. Only pass minimal identifiers (like `catalogId`) needed for the component to fetch/filter its own data.
- **Use react-hook-form for forms**: Prefer `useForm` over multiple `useState` hooks for form state management. Pass form objects to child components via `form: UseFormReturn<FormValues>` prop rather than individual state setters. Parent components handle mutations and submission, form components focus on rendering.
- **Reuse API types from @shared**: Use types from `archestraApiTypes` (e.g., `archestraApiTypes.CreateXxxData["body"]`, `archestraApiTypes.GetXxxResponses["200"]`) instead of defining duplicate types. Import from `@shared`.
- **Documentation URLs**: Always use `getDocsUrl(DocsPage.PageName, "optional-anchor")` from `@shared` to construct docs links. Never hardcode docs URLs.

**Backend**:

- Use Drizzle ORM for database operations through MODELS ONLY!
- Table exports: Use plural names with "Table" suffix (e.g., `profileLabelsTable`, `sessionsTable`)
- Colocate test files with source (`.test.ts`)
- Flat file structure, avoid barrel files
- **Route permissions (IMPORTANT)**: When adding new API endpoints, you MUST add the route to `requiredEndpointPermissionsMap` in `shared/access-control.ee.ts` or requests will return 403 Forbidden. Match permissions with similar existing routes (e.g., interaction endpoints use `interaction: ["read"]`).
- **MCP Tool Impact (IMPORTANT)**: When updating an API endpoint's request/response schema, also check if there is an associated Archestra MCP tool in `backend/src/archestra-mcp-server/` that exposes the same functionality. If so, update the MCP tool's `inputSchema` and handler to match the new API schema. Ask the user if you're unsure whether an MCP tool is affected.
- Only export public APIs
- **Module Code Order (CRITICAL)**: Always place exports at TOP of file, internal helpers at BOTTOM. Use section comments (`// ===`) to separate. Function declarations are hoisted, so helpers can be called before defined.
- Use the `logger` instance from `@/logging` for all logging (replaces console.log/error/warn/info)
- **Backend Testing Best Practices**: Never mock database interfaces in backend tests - use the existing `backend/src/test/setup.ts` PGlite setup for real database testing, and use model methods to create/manipulate test data for integration-focused testing
- **API Response Standardization**: Use `constructResponseSchema` helper for all routes to ensure consistent error responses (400, 401, 403, 404, 500)
- **Error Handling**: Always use `throw new ApiError(statusCode, message)` for error responses - never use manual `reply.status().send({ error: ... })`. The centralized Fastify error handler formats all errors consistently as `{ error: { message, type } }` and logs appropriately.
- **Protected Routes & Authentication**: Routes under `/api/` are protected by the auth middleware which guarantees `request.user` and `request.organizationId` exist. Never add redundant null checks like `if (!request.organizationId) throw new ApiError(401, "Unauthorized")` - just use `request.organizationId` directly. The middleware handles authentication; routes handle authorization and business logic.
- **Type Organization**: Keep database schemas in `database/schemas/`, extract business types to dedicated `types/` files
- **Pagination**: Use `PaginationQuerySchema` and `createPaginatedResponseSchema` for consistent pagination across APIs
- **Sorting**: Use `SortingQuerySchema` or `createSortingQuerySchema` for standardized sorting parameters
- **Database Types via drizzle-zod**: Never manually define TypeScript interfaces for database entities. Use `drizzle-zod` to generate Zod schemas from Drizzle table definitions, then infer types with `z.infer<>`. This keeps types in sync with the schema automatically:

  ```typescript
  // In types/<entity>.ts
  import {
    createSelectSchema,
    createInsertSchema,
    createUpdateSchema,
  } from "drizzle-zod";
  import { schema } from "@/database";

  export const SelectEntitySchema = createSelectSchema(schema.entityTable);
  export const InsertEntitySchema = createInsertSchema(schema.entityTable).omit(
    { id: true, createdAt: true, updatedAt: true },
  );
  export const UpdateEntitySchema = createUpdateSchema(schema.entityTable).pick(
    { fieldToUpdate: true },
  );

  export type Entity = z.infer<typeof SelectEntitySchema>;
  export type InsertEntity = z.infer<typeof InsertEntitySchema>;
  export type UpdateEntity = z.infer<typeof UpdateEntitySchema>;
  ```

- **Schema `$type<>` reuse**: In `database/schemas/*.ts`, never use inline literal union types for `.$type<>()` (e.g. `$type<"pending" | "completed">()`). Instead, define the type as a `z.enum()` in the corresponding `types/*.ts` file, infer the TS type, and reference it via `import type` in the schema: `.$type<EmbeddingStatus>()`. This keeps the type definition in one place and avoids drift between schema and types.

**Team-based Access Control**:

- Profiles and MCP servers use team-based authorization
- Teams managed via better-auth organization plugin
- Junction tables: `profile_team` and `mcp_server_team`
- Breaking change: `usersWithAccess[]` replaced with `teams[]`
- Admin-only team CRUD via `/api/teams/*`
- Members can read teams and access assigned resources

**Custom RBAC Roles**:

- Extends predefined roles (admin, member)
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
- Feature flag `orchestratorK8sRuntime` returned by `/api/features` endpoint
- Feature enabled when EITHER ARCHESTRA_ORCHESTRATOR_KUBECONFIG or ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER is configured
- Frontend disables local MCP server functionality when feature is off (shows tooltip explaining orchestratorK8sRuntime requirement)
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


**TOON Format Conversion**:

- Agents support optional TOON (Token-Oriented Object Notation) conversion for tool results
- Reduces token usage by 30-60% for uniform arrays of objects
- Enabled via `convert_tool_results_to_toon` boolean field on agents
- Automatically converts JSON tool results to TOON format before sending to LLM
- Particularly useful for agents dealing with structured data from database or API tools

**Chat Feature**:

- Agent-based conversations: Each conversation is tied to a specific agent
- MCP tool integration: Chat automatically uses the agent's assigned MCP tools via MCP Gateway
- LLM Proxy integration: Chat routes through LLM Proxy for security policies + observability
- Agent authentication: Connects to internal MCP Gateway using `Authorization: Bearer ${archestraToken}` with agent ID in URL path
- Conversation management: Select, edit (inline rename), delete conversations directly in sidebar sub-navigation
- Tool execution: Routes through MCP Gateway, includes response modifiers and logging
- Required env var: `ARCHESTRA_CHAT_ANTHROPIC_API_KEY` (used by LLM Proxy for Anthropic calls)

**Archestra MCP Server**:

- Tools must be explicitly assigned to Agents (not auto-injected)
- Tools prefixed with `archestra__` to avoid conflicts
- Implementation: `backend/src/archestra-mcp-server/` (modular directory with one file per tool group)
- Catalog entry: Created automatically on startup with fixed ID `ARCHESTRA_MCP_CATALOG_ID`
- Security:
  - **Trusted (policy bypass)**: Archestra tools bypass tool invocation policies and trusted data policies — they are always allowed to execute without policy evaluation
  - **RBAC (user permissions) still enforced**: Every tool is mapped to a `{ resource, action }` permission in `TOOL_PERMISSIONS` (`archestra-mcp-server/rbac.ts`). The `tools/list` endpoint dynamically filters tools so users only see tools they have permission to use. `executeArchestraTool` performs a centralized RBAC check before executing any tool. When adding new tools, add the corresponding entry to `TOOL_PERMISSIONS` (the `Record<ArchestraToolShortName, ...>` type will cause a compile error if a tool is missing).

**Testing**:

- **Backend**: Vitest with PGLite for in-memory PostgreSQL testing - never mock database interfaces, use real database operations via models for comprehensive integration testing
- **Test What Matters**: Prefer behavior-focused tests over implementation-detail tests. Do not add tests that only assert class names, prop plumbing, or incidental markup unless that detail is itself the contract.
- **E2E Tests**: Playwright with test fixtures pattern - import from `./fixtures` in API/UI test directories
- **E2E Test Fixtures**:
  - API fixtures: `makeApiRequest`, `createAgent`, `deleteAgent`, `createApiKey`, `deleteApiKey`, `createToolInvocationPolicy`, `deleteToolInvocationPolicy`, `createTrustedDataPolicy`, `deleteTrustedDataPolicy`
  - UI fixtures: `goToPage`, `makeRandomString`
- **Backend Test Fixtures**: Import from `@/test` to access Vitest context with fixture functions. Available fixtures: `makeUser`, `makeAdmin`, `makeOrganization`, `makeTeam`, `makeAgent`, `makeTool`, `makeAgentTool`, `makeToolPolicy`, `makeTrustedDataPolicy`, `makeCustomRole`, `makeMember`, `makeMcpServer`, `makeInternalMcpCatalog`, `makeInvitation`, `seedAndAssignArchestraTools`

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
await page.locator(".submit-btn").click();
await page.locator("#email-input").fill("test@example.com");
await page.waitForTimeout(1000); // Use auto-waiting instead
```

Reference: https://playwright.dev/docs/locators#quick-guide

- never amend commits
