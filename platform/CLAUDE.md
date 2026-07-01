# Individual Preferences

- @CLAUDE_LOCAL.md

## Working Directory

**ALWAYS run all commands from the `platform/` directory unless specifically instructed otherwise.**

## Important Rules

1. **Use pnpm** for package management
2. **Use Tilt for development** - `tilt up` to start the full environment
4. **Documentation Updates** - For any feature or system changes, audit `../docs/pages` to determine if existing content needs modification/updates or if new documentation should be added. Follow the writing guidelines in `../docs/docs_writer_prompt.md`
5. **Add Tests for Behavior** - When a change alters observable behavior, add or update tests that pin that behavior (unit, integration, or e2e under `platform/e2e-tests/tests`). Favor behavior-focused tests over implementation-detail ones — skip tests that only assert wiring, prop plumbing, or incidental markup. Tests exercise real code; mock only true process boundaries (network, clock, subprocesses, externally-owned storage). Skipping tests is a judgment call to state explicitly, not a silent default
6. **Enterprise Licensing** — The repo is dual-licensed: AGPL-3.0 by default (`../LICENSE_AGPL`), Enterprise License (`../LICENSE_ENTERPRISE`) for marked code. See the license router at `../LICENSE.md` for the resolution rules. Pricing and scope: docs/pages/platform-pricing-model.md. When you add or modify code of enterprise features, tag it as Enterprise using mechanism described in LICENSE.md.
7. **Commit Freely, Push With Approval** - Committing locally as you land reviewable slices is fine. Never push, open, or update a PR without explicit user approval, and never amend commits
8. **No Database Modifications Without Approval** - NEVER run INSERT, UPDATE, DELETE, or any data-modifying SQL queries without explicit user approval. SELECT queries for reading data are allowed. Always ask before modifying database data directly.
9. **NEVER MENTION REAL CUSTOMER NAMES OR IDENTIFIERS ANYWHERE IN CODE, COMMENTS, TESTS, DOCS, COMMITS, OR PR TEXT!!!!!!!!!!**
10.  **Never copy anything from Sentry into code, comments, tests, docs, commits, or PR text — and do not mention Sentry itself.** Sentry is for diagnosing the problem; describe the bug in neutral terms and cite no IDs, environments, URLs, user info, or stack snippets from there.
11. If you think there is an important bit of information worth remembering between sessions, suggest adding it to CLAUDE.md instead of memorizing it yourself. CLAUDE.md is the single source of truth for all important information about the platform, its architecture, and its development practices.

## Docs

Docs are stored at ./docs
Check ./docs/docs_writer_prompt.md before changing docs files.

## Project Skills

Load these project skills when the task matches their domain:

- `archestra-dev-frontend` - use for frontend Next.js/React work, UI components, forms, TanStack Query hooks, generated API clients, white-label copy, and docs links.
- `archestra-dev-migrations` - use for Drizzle schema changes, generated migrations, data migrations, custom migrations, `drizzle-kit check` failures, or migration conflict resolution via its `resolve-conflicts.md` subpage.
- `archestra-dev-e2e` - use for Playwright e2e tests, API/UI fixtures, WireMock setup, local/CI e2e behavior, and locator guidance.
- `archestra-dev-observability` - use for tracing, metrics, OpenTelemetry, Tempo, Grafana, Prometheus, LLM/MCP spans, or observability label changes.
- `archestra-dev-rust-napi` - use for Rust core code, NAPI bindings, generated TypeScript bindings, Rust telemetry, and Rust checks.
- `archestra-dev-override-sweep` - use for sweeping pnpm `overrides` and `minimumReleaseAge` exclusions in `pnpm-workspace.yaml` — unwinding matured CVE pins and removing overrides the dependency graph has made redundant.

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

# Database Connection
# PostgreSQL is running in Kubernetes (managed by Tilt)
# Connect to database:
kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password psql -U archestra -d archestra_dev

# Common queries: \dt (list tables), \d table_name (describe table), SELECT COUNT(*) FROM drizzle.__drizzle_migrations;

# Logs
tilt logs pnpm-dev-backend           # Get backend logs
tilt logs pnpm-dev-frontend          # Get frontend logs
tilt trigger <pnpm-dev-backend|pnpm-dev-frontend|wiremock|etc> # Trigger an update for the specified resource
```

## Environment Variables

**Naming Convention**: All env vars MUST follow the pattern `ARCHESTRA_<PRODUCT_AREA>_<THING>` (e.g., `ARCHESTRA_LLM_PROXY_MAX_VIRTUAL_KEYS`, `ARCHESTRA_OTEL_VERBOSE_TRACING`).

**Adding New Env Vars**:

1. **Consume in `backend/src/config.ts`** - Parse and validate the env var here. If a custom parse/validation function is needed, export it and add tests in `backend/src/config.test.ts`
2. **Add to `platform/.env.example`** - Every new env var MUST be listed here with a short comment, so local setups and deployments discover it
3. **Document in `../docs/pages/platform-deployment.md`** - All new env vars MUST be documented in the Environment Variables section. Use best judgement on whether it warrants a new subsection
4. **Frontend access via `/api/config`** - If the frontend needs to reference an env var value, expose it through `backend/src/routes/config.ts` response and consume via the `useFeature()` hook

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

## Dependency Security

**Install Script Protection**: The platform disables automatic execution of install scripts via `ignoreScripts: true` in `pnpm-workspace.yaml` to prevent supply chain attacks. Install scripts (`preinstall`, `postinstall`, `install`) can execute arbitrary code, steal secrets, and compromise the system.

**Minimum Release Age**: Packages must be published for at least 7 days before installation (`minimumReleaseAge: 10080` minutes in `pnpm-workspace.yaml`). This allows time for community detection and removal of malicious releases, which are typically caught within hours.

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

- For frontend work, load the `archestra-dev-frontend` skill before editing React/Next.js UI, forms, query hooks, generated API client usage, copy, or docs links.

**Backend**:

- Refer to backend/architecture.md for backend architecture guidelines.
- Use Drizzle ORM for database operations through MODELS ONLY!
- Table exports: Use plural names with "Table" suffix (e.g., `profileLabelsTable`, `sessionsTable`)
- **Route permissions (IMPORTANT)**: When adding new API endpoints, you MUST add the route to `requiredEndpointPermissionsMap` in `shared/access-control.ee.ts` or requests will return 403 Forbidden. Match permissions with similar existing routes (e.g., interaction endpoints use `interaction: ["read"]`).
- **MCP Tool Impact (IMPORTANT)**: When updating an API endpoint's request/response schema, also check if there is an associated Archestra MCP tool in `backend/src/archestra-mcp-server/` that exposes the same functionality. If so, update the MCP tool's `inputSchema` and handler to match the new API schema. Ask the user if you're unsure whether an MCP tool is affected.
- Only export public APIs
- **knip --production (IMPORTANT)**: Backend `check:ci` runs `pnpm knip` = `knip:dev && knip:production`. The `--production` pass ignores `*.test.ts` and cross-workspace consumers (e.g. the `standalone-scripts/` index generator), so an export used only by tests or those scripts fails CI even though plain `knip` passes. Before pushing backend export changes, run `cd backend && pnpm knip` (the full dev+production combo). Tag intentionally-public exports consumed only outside knip's view with a JSDoc `/** @public — reason */` tag (see `config.ts`, `middleware.ts`).
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

**Skill Sandbox Runtime** (gated behind the sandbox feature flag):

- DB-backed, Dagger-materialized execution sandbox for Agent Skills. Code lives in `backend/src/skills-sandbox/` (see its README for replay semantics and limits)
- MCP tools exposed by `archestra-mcp-server/sandbox.ts`, all gated by `sandbox:execute` (`archestra-mcp-server/rbac.ts`). Each accepts a `target?: { fresh: true } | { id }` — omitted resolves a lazy per-conversation default sandbox:
  - `run_command` — materializes the sandbox in a fresh Dagger container, replays the persisted ordered replay log, executes a command, appends it to the log. Python runs in a uv project at `/home/sandbox` (`python3` is the project venv; install packages with `uv add --project /home/sandbox <pkg>`)
  - `upload_file` — writes an input file (chat attachment, base64, or text) into the sandbox as an ordered replay event so it materializes on later runs
  - `download_file` — exports a file from a materialized sandbox into `skill_sandbox_files` (kind `artifact`) and returns a metadata reference (no download link; the file is reached via the chat Files panel, which fetches bytes from the `/api/skill-sandbox/artifacts/:id` route directly)
- Chat attachments are auto-staged into the conversation's **default** sandbox under `/home/sandbox/attachments/` (idempotent, tracked via `skill_sandbox_files.source_attachment_id`), so the model uses user-attached files without knowing attachment ids. Over-limit attachments are skipped with a model-visible notice. `upload_file` stays the path for inline content, explicit paths, non-default sandboxes, and non-UI gateway clients
- `load_skill` (and slash-command activation) mounts the skill's pinned version into the conversation's default sandbox when the sandbox is usable, so its scripts are runnable under `/skills/<name>`. This happens for both `load_skill` modes (name only, and name + path), so a file read also mounts the skill. `run_command`/`download_file` re-check that every mounted skill is still readable by the caller before building a container (fail-closed)
- Source of truth is Postgres (`skill_sandboxes`, `skill_sandbox_skill_mounts`, `skill_sandbox_commands`, `skill_sandbox_files`, `skill_sandbox_replay_events`); skill bytes are versioned immutably in `skill_versions` + `skill_version_files` and mounts pin a `skill_version_id`. Dagger owns ephemeral filesystem state with no retention guarantee. Ordering across commands/uploads/mounts is the `skill_sandbox_replay_events` log, sequenced via `skill_sandboxes.next_replay_sequence`
- Activation prompt (`skills/skill-activation.ts`) tells the model to inspect files with `load_skill` (passing a path) and use the sandbox tools to execute scripts. Each mounted skill root (`/skills/<name>`) is appended to `PYTHONPATH` (in `archestra-rs/sandbox-core/src/backends/dagger.rs`), so the model imports a skill's modules directly without `sys.path` edits. `run_command`'s cwd defaults to `/home/sandbox`, **not** the skill root, so a bundled script that reads its own files by relative path must be run with `cwd: /skills/<name>`

**Testing**:

- **Backend**: Vitest with PGLite for in-memory PostgreSQL testing - never mock database interfaces, use real database operations via models for comprehensive integration testing
- **Test What Matters**: Prefer behavior-focused tests over implementation-detail tests. Do not add tests that only assert class names, prop plumbing, or incidental markup unless that detail is itself the contract.
- **E2E Tests**: Load the `archestra-dev-e2e` skill for Playwright tests, fixtures, WireMock setup, local/CI behavior, and locator guidance.
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

- never amend commits
