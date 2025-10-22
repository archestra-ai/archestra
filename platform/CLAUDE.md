# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**⚠️ IMPORTANT: This file must be kept in sync with `.cursor/rules/` (for Cursor IDE users). When updating one, update the other.**

> **Note for Cursor IDE users**: This project now uses modern Project Rules in `.cursor/rules/` directory. The legacy `.cursorrules` file is deprecated.

## Working Directory

**ALWAYS run all commands from the `platform/` directory unless specifically instructed otherwise.**

## Documentation

**Documentation files are located at `../../website/app/app/docs/content/`** (relative to the `platform/` directory). When asked to update or create documentation, edit or create files in that directory.

**Important**: When using tools that require absolute paths (like Read, Write, Edit), you must convert the relative path to an absolute path. Use `realpath ../../website/app/app/docs/content/` to get the absolute path, then use that with file operation tools.

## Important Rules

1. **ALWAYS use pnpm** (not npm or yarn) for package management
2. **Use Biome for formatting and linting** - Run `pnpm lint` before committing changes
3. **TypeScript strict mode** - Ensure code passes `pnpm type-check` before completion
4. **Tilt for development** - The project uses Tilt to orchestrate the development environment
5. **Use shadcn/ui components** - Add components with `npx shadcn@latest add <component>` instead of using Radix UI directly

## Monitoring and Debugging

### Tilt Web UI

When running `tilt up`, the Tilt web UI is available at http://localhost:10350/ and provides:

- **Backend logs**: http://localhost:10350/r/pnpm-dev/overview - View real-time logs from the backend server
- **Frontend logs**: http://localhost:10350/r/pnpm-dev/overview - View Next.js development logs
- **Lint errors**: http://localhost:10350/r/lint%3Afix/overview - See linting and type-check errors
- **Resource refresh**: Each resource has a refresh button to restart individual services without restarting Tilt
- **Clear Logs**: Click on any resource, then click the "Clear Logs" button in the top right corner to clear logs for better visibility
  - Alternative: Kill the `tilt up` process and run it again to clear all logs

### Frontend Application

- **Frontend UI**: http://localhost:3000/ - Main application interface
- **Tools Inspector**: http://localhost:3000/tools - Inspect all requests and responses flowing through the Archestra proxy in real-time
- **Dual LLM Configuration**: http://localhost:3000/dual-llm - Configure the dual LLM quarantine pattern for enhanced security

### Database Inspection

- **Drizzle Studio**: https://local.drizzle.studio/ - View and edit database tables and schema in a web UI

### Using Playwright MCP for Browser Automation

To access the Tilt web UI and Drizzle Studio programmatically, use the Playwright MCP:

```bash
claude mcp add playwright npx @playwright/mcp@latest
```

## Common Development Commands

### Starting the Development Environment

```bash
tilt up              # Start full development environment (recommended)
pnpm dev             # Manually start all workspaces in dev mode
```

### Docker Compose Development

```bash
# Run platform with Open WebUI integration
docker-compose -f docker-compose-openwebui.yml up
```

### Individual Workspace Commands

```bash
# Backend (Fastify server)
cd backend
pnpm dev             # Start backend in watch mode
pnpm build           # Compile TypeScript to dist/
pnpm start           # Run compiled backend
pnpm test            # Run tests with Vitest
pnpm db:migrate      # Run database migrations
pnpm db:migrate:dev  # Run migrations in dev mode
pnpm db:studio       # Open Drizzle Studio for database inspection

# Frontend (Next.js)
cd frontend
pnpm dev             # Start Next.js dev server with Turbopack
pnpm build           # Build for production
pnpm start           # Start production server

# Experiments (Proxy & Guardrails)
cd experiments
pnpm proxy:dev       # Start OpenAI proxy server on port 9000
pnpm cli-chat-with-guardrails  # Test guardrails CLI (interactive, requires user input)
```

### Environment Variables

The platform uses the following environment variables:

```bash
# Required
DATABASE_URL="postgresql://archestra:archestra_dev_password@localhost:5432/archestra_dev?schema=public"

# Optional (not included in default Helm deployment)
ARCHESTRA_API_BASE_URL="http://localhost:9000"  # Proxy URL displayed in UI (defaults to http://localhost:9000/v1)
NEXT_PUBLIC_ARCHESTRA_API_BASE_URL="http://localhost:9000"  # Frontend-specific env var (defaults to ARCHESTRA_API_BASE_URL if not set)

# Allowed Frontend Origins (optional)
ARCHESTRA_ALLOWED_FRONTEND_ORIGINS="https://app.example.com,https://dashboard.example.com"  # Comma-separated list of allowed frontend origins
# If not set, defaults to localhost regex (allows http(s)://localhost on any port)
# Examples:
#   Single domain: ARCHESTRA_ALLOWED_FRONTEND_ORIGINS="https://app.example.com"
#   Multiple domains: ARCHESTRA_ALLOWED_FRONTEND_ORIGINS="https://app.example.com,https://dashboard.example.com"
#   Local development: ARCHESTRA_ALLOWED_FRONTEND_ORIGINS="http://localhost:3000"
# Note: Wildcard "*" is not supported due to credentials mode (cookie-based authentication)

# Provider API Keys (server-side configuration)
OPENAI_API_KEY=your-api-key-here  # Required for OpenAI provider
GEMINI_API_KEY=your-api-key-here  # Required for Gemini provider
ANTHROPIC_API_KEY=your-api-key-here  # Required for Anthropic provider

# Note: For client applications using the proxy:
# - OpenAI: Pass API key in Authorization header as "Bearer <key>"
# - Gemini: Pass API key in x-goog-api-key header
# - Anthropic: Pass API key in x-api-key header
```

The `ARCHESTRA_API_BASE_URL` environment variable allows customizing the proxy URL that users see in the Settings page. The platform intelligently handles various URL formats:
- URLs already ending with `/v1` are used as-is
- URLs with trailing slashes have the slash removed before appending `/v1`
- URLs without trailing components get `/v1` appended
- Empty string is treated as if the env var is not set (defaults to http://localhost:9000/v1)
- The backend also uses this URL to parse the port for server binding

The `NEXT_PUBLIC_ARCHESTRA_API_BASE_URL` environment variable is used specifically by the frontend. If not set, it defaults to the value of `ARCHESTRA_API_BASE_URL`. This allows for separate frontend/backend configuration if needed.

### Testing with Example CLI Chats

The platform includes two example CLI chat applications for testing:

```bash
# 1. Experiments CLI Chat (TypeScript with OpenAI/Gemini SDKs)
cd experiments
pnpm cli-chat-with-guardrails
# Interactive CLI - supports commands:
# - Regular messages to chat with the AI
# - /help - Show available commands
# - /exit - Exit the program
# Flags:
#   --include-external-email  # Include external email in mock Gmail data
#   --include-malicious-email # Include malicious email with prompt injection
#   --stream                  # Stream the response
#   --model <model>           # Specify model (default: gpt-4o for OpenAI, gemini-1.5-pro for Gemini)
#   --provider <provider>     # Provider selection: "openai", "gemini", or "anthropic" (default: openai)
#   --debug                   # Print debug messages

# 2. AI SDK Express Example (TypeScript with Vercel AI SDK)
cd examples/ai-sdk-express
pnpm dev
# Interactive CLI - type messages to chat, "exit" or "quit" to exit
# This example demonstrates AI SDK integration with Archestra proxy
# Tool: get_file - reads files from the file system
```

Both examples connect to Archestra backend on http://localhost:9000/v1/openai and demonstrate:
- Tool invocation policies (blocking untrusted tool calls)
- Trusted data policies (marking data as trusted/untrusted)
- Request/response interception and logging
```

### Code Quality

```bash
pnpm type-check      # Check TypeScript types across all workspaces
pnpm lint            # Lint and auto-fix with Biome
pnpm format          # Format code with Biome
pnpm test            # Run tests with Vitest (backend only for now)
```

## High-Level Architecture

### Overview

Archestra Platform is an enterprise Model Context Protocol (MCP) platform built as a monorepo using pnpm workspaces and Turbo. The platform consists of three main workspaces: backend (Fastify API), frontend (Next.js app), and experiments (proxy server and security guardrails).

### Core Tech Stack

- **Monorepo**: pnpm workspaces with Turbo for build orchestration
- **Development**: Tilt for local development orchestration
- **Backend**: Fastify server with pino logging + Drizzle ORM (PostgreSQL)
- **Frontend**: Next.js 15.5.4 with React 19 + Turbopack + Tailwind CSS 4 + shadcn/ui
- **UI Components**: shadcn/ui (add with `npx shadcn@latest add <component>`)
- **Database**: PostgreSQL with Drizzle ORM for interaction persistence
- **Security**: Production-ready guardrails with dual LLM pattern and taint analysis
- **Build System**: TypeScript with separate tsconfig per workspace
- **Code Quality**: Biome for linting and formatting

### Workspace Architecture

```
platform/
├── backend/           # Fastify REST API server with integrated guardrails
│   ├── drizzle.config.ts        # Drizzle configuration
│   └── src/
│       ├── config.ts            # Application configuration
│       ├── server.ts            # Main Fastify server (port 9000)
│       ├── types/               # TypeScript type definitions
│       │   ├── llm-providers/   # LLM provider type definitions
│       │   │   ├── openai/      # OpenAI API types (messages, tools, etc.)
│       │   │   └── gemini/      # Gemini API types (messages, tools, etc.)
│       │   └── ...              # Other type definitions
│       ├── database/            # Database layer
│       │   ├── migrations/      # Drizzle migrations
│       │   └── schema.ts        # Database schema
│       ├── guardrails/          # Security guardrails (production-ready)
│       │   ├── dual-llm.ts      # Dual LLM pattern for prompt injection detection
│       │   ├── tool-invocation.ts  # Tool invocation policy enforcement
│       │   └── trusted-data.ts     # Taint analysis and trusted data marking
│       ├── models/              # Data models
│       │   ├── agent.ts         # Agent model with CRUD operations
│       │   ├── interaction.ts   # Interaction model (stores full request/response)
│       │   ├── tool-invocation-policy.ts  # Tool invocation policy model
│       │   └── trusted-data-policy.ts     # Trusted data policy model
│       ├── providers/           # LLM provider abstraction
│       │   ├── factory.ts       # Provider factory pattern
│       │   ├── openai.ts        # OpenAI provider implementation
│       │   ├── gemini.ts        # Gemini provider implementation
│       │   └── types.ts         # Provider interfaces
│       └── routes/              # API routes
│           ├── agent.ts         # Agent management endpoints
│           ├── autonomy-policies.ts  # Autonomy policies endpoints
│           ├── interaction.ts   # Interaction endpoints (list, get by ID)
│           └── proxy/           # LLM provider proxy with integrated guardrails
│               ├── openai.ts    # OpenAI proxy route handler
│               ├── gemini.ts    # Gemini proxy route handler
│               ├── types/       # TypeScript types for proxy routes
│               └── utils/       # Proxy utilities (modular structure)
│                   ├── index.ts              # Core agent management, message persistence
│                   ├── tool-invocation.ts    # Tool invocation policy evaluation
│                   ├── tools.ts              # MCP tool persistence and injection
│                   ├── trusted-data.ts       # Trusted data policy evaluation and taint tracking
│                   ├── dual-llm-client.ts     # Provider-agnostic LLM client interface for dual LLM pattern
│                   └── dual-llm-subagent.ts  # Dual LLM pattern implementation for quarantining untrusted data
├── frontend/          # Next.js web application
│   └── src/
│       └── app/       # Next.js App Router pages
│           ├── tools/     # Tool management UI (view tools, configure policies)
│           └── dual-llm/  # Dual LLM agent configuration page
├── experiments/       # Experimental features and prototypes
│   └── src/
│       ├── main.ts              # OpenAI proxy server (port 9000)
│       ├── interceptor.ts       # Request interception logic
│       ├── logger.ts            # Logging utilities
│       └── cli-chat.ts          # CLI chat interface for testing
└── shared/            # Shared utilities (currently empty)
```

### Dual LLM Pattern

The platform implements the Dual LLM Quarantine Pattern to prevent prompt injection attacks when processing untrusted data:

- **Main Agent**: Formulates questions without access to untrusted data
- **Quarantined Agent**: Examines untrusted data but can only respond with structured multiple choice answers
- **Information Flow**: Controlled Q&A rounds between agents (configurable max rounds)
- **Configuration**: Manage prompts and settings at http://localhost:3000/dual-llm
- **Implementation**: 
  - `dual-llm-subagent.ts`: Core dual LLM pattern implementation
  - `dual-llm-client.ts`: Provider-agnostic interface supporting both OpenAI and Anthropic
- **Database**: 
  - Configuration stored in `dual_llm_config` table
  - Results stored in `dual_llm_result` table for auditing
- **Usage**: 
  - Automatically invoked when tool's `toolResultTreatment` is set to "sanitize_with_dual_llm"
  - Can be triggered by trusted data policies with action "sanitize_with_dual_llm"
  - Provides an additional security layer for handling potentially malicious tool outputs

### Development Orchestration

The project uses **Tilt** to orchestrate the development environment:

1. **Pre-requisites**: Runs `pnpm install` before starting services
2. **Dev Services**: Starts `pnpm dev` (via Turbo) to run all workspaces
3. **Linting**: Runs `pnpm type-check && pnpm lint` continuously

Tilt automatically manages dependencies and ensures services start in the correct order.

### Backend API

The production backend provides:

#### Supported LLM Providers

- **OpenAI**: Fully implemented with chat completions, tools, and streaming support
  - Requires `OPENAI_API_KEY` environment variable
- **Google Gemini**: Fully implemented with generateContent, tools, and streaming support
  - Comprehensive TypeScript types for Gemini API (`platform/backend/src/types/llm-providers/gemini/`)
  - Database schema supports provider field to distinguish between providers
  - Requires `GEMINI_API_KEY` environment variable
  - Gemini API requests require `x-goog-api-key` header with API key
- **Anthropic**: Messages API support with tool invocation and trusted data policies
  - TypeScript types for Anthropic API (`platform/backend/src/types/llm-providers/anthropic/`)
  - Requires `ANTHROPIC_API_KEY` environment variable
  - Anthropic API requests require `x-api-key` header with API key
  - Tool invocation policies evaluation now supports Anthropic format
  - Dual LLM pattern fully supported for quarantining untrusted data
  - Streaming support: Full Server-Sent Events (SSE) streaming for real-time responses

#### REST API Endpoints

- **Interaction Management**:
  - `GET /api/interactions` - List all interactions (with optional agentId filter)
  - `GET /api/interactions/:id` - Get interaction by ID
  - Interactions are linked directly to agents (chat model has been removed)
- **LLM Integration**:
  - OpenAI:
    - `POST /v1/openai/chat/completions` - Default agent endpoint (creates/uses agent based on user-agent header)
    - `POST /v1/openai/:agentId/chat/completions` - Agent-specific endpoint for multi-agent scenarios
    - `GET /v1/openai/models` - List available OpenAI models
  - Gemini:
    - `POST /v1/gemini/models/:model:generateContent` - Default agent generateContent endpoint
    - `POST /v1/gemini/models/:model:streamGenerateContent` - Default agent streaming endpoint
    - `POST /v1/gemini/:agentId/models/:model:generateContent` - Agent-specific generateContent
    - `POST /v1/gemini/:agentId/models/:model:streamGenerateContent` - Agent-specific streaming
    - `GET /v1/gemini/models` - List available Gemini models
  - Anthropic:
    - `POST /v1/anthropic/messages` - Default agent messages endpoint
    - `POST /v1/anthropic/:agentId/messages` - Agent-specific messages endpoint
    - Routes for other Anthropic API endpoints are proxied directly (e.g., `/v1/anthropic/models`)
  - Supports streaming responses for real-time AI interactions
  - **Supported Providers**: OpenAI (full), Google Gemini (full), Anthropic (messages API)
- **Agent Management**:
  - `GET /api/agents` - List all agents
  - `POST /api/agents` - Create new agent
  - `GET /api/agents/:id` - Get agent by ID
  - `PUT /api/agents/:id` - Update agent
  - `DELETE /api/agents/:id` - Delete agent
  - `GET /api/agents/:id/tool-invocation-policies` - Get agent's tool policies
  - `POST /api/agents/:id/tool-invocation-policies` - Add policy to agent
  - `DELETE /api/agents/:agentId/tool-invocation-policies/:policyId` - Remove policy
- **Autonomy Policies**:
  - `GET /api/autonomy-policies/operators` - Get supported operators
  - Tool Invocation Policies:
    - `GET /api/autonomy-policies/tool-invocation` - List all policies
    - `POST /api/autonomy-policies/tool-invocation` - Create policy
    - `GET /api/autonomy-policies/tool-invocation/:id` - Get policy
    - `PUT /api/autonomy-policies/tool-invocation/:id` - Update policy
    - `DELETE /api/autonomy-policies/tool-invocation/:id` - Delete policy
  - Trusted Data Policies:
    - `GET /api/trusted-data-policies` - List all policies
    - `POST /api/trusted-data-policies` - Create policy
    - `GET /api/trusted-data-policies/:id` - Get policy
    - `PUT /api/trusted-data-policies/:id` - Update policy
    - `DELETE /api/trusted-data-policies/:id` - Delete policy
- **Tool Management**:
  - `GET /api/tools` - List all tools (no longer contains security configurations)
  - `GET /api/agent-tools` - List agent-tool relationships with security configurations
  - `POST /api/agent-tools` - Create agent-tool relationship with security settings
  - `PATCH /api/agent-tools/:agentId/:toolId` - Update agent-tool security configuration
  - `DELETE /api/agent-tools/:agentId/:toolId` - Remove agent-tool relationship
- **Dual LLM Configuration**:
  - `GET /api/dual-llm-config/default` - Get default configuration
  - `GET /api/dual-llm-config` - List all configurations
  - `POST /api/dual-llm-config` - Create configuration
  - `GET /api/dual-llm-config/:id` - Get configuration by ID
  - `PUT /api/dual-llm-config/:id` - Update configuration
  - `DELETE /api/dual-llm-config/:id` - Delete configuration
- **Dual LLM Results**:
  - `GET /api/dual-llm-results/by-tool-call-id/:toolCallId` - Get result by tool call ID
  - `GET /api/dual-llm-results/by-interaction/:interactionId` - Get results by interaction
  - `GET /api/dual-llm-results` - List all results (with optional agentId filter)
  - `GET /api/dual-llm-results/:id` - Get result by ID
  - `POST /api/dual-llm-results` - Create result (internal use)
  - `PUT /api/dual-llm-results/:id` - Update result (internal use)
  - `DELETE /api/dual-llm-results/:id` - Delete result

#### Security Features (Production-Ready)

The backend integrates advanced security guardrails:

- **MCP Tool Injection**: Automatic injection of Model Context Protocol (MCP) tools at the proxy level
  - Tools from incoming requests are persisted to the database
  - Agent-assigned MCP tools are automatically injected into LLM requests
  - Assigned tools take priority over request tools with the same name
  - Supports OpenAI and Anthropic providers (Gemini support prepared)
  - Tools are linked to agents via the agent_tools junction table
- **Dual LLM Pattern**: Quarantined + privileged LLMs for prompt injection detection
  - Main Agent: Formulates questions without access to untrusted data
  - Quarantined Agent: Accesses untrusted data but can only respond via structured multiple choice
  - Prevents prompt injection by isolating untrusted data from the main LLM
  - Configurable via UI at http://localhost:3000/dual-llm
  - Operation flow:
    1. Main agent formulates questions about the untrusted data
    2. Quarantined agent examines the data and responds with structured answers
    3. Process continues for configured number of rounds (maxRounds)
    4. Final summary is generated based on the Q&A conversation
  - Results stored in database for auditing and analysis
  - Can be triggered via:
    - Tool `toolResultTreatment` set to "sanitize_with_dual_llm"
    - Trusted data policy action "sanitize_with_dual_llm"
- **Tool Invocation Policies**: Fine-grained control over tool usage
  - Control when tools can be invoked based on argument values
  - Support for multiple operators (equal, notEqual, contains, startsWith, endsWith, regex)
  - Actions: allow_when_context_is_untrusted or block_always with custom reason text
  - Agent-tool relationships can be configured with:
    - `allowUsageWhenUntrustedDataIsPresent`: Allow tool to run with untrusted data
    - `toolResultTreatment`: How tool outputs are handled ("trusted", "untrusted", or "sanitize_with_dual_llm")
- **Trusted Data Policies**: Mark specific data patterns as trusted, blocked, or for sanitization
  - Uses attribute paths to identify data fields
  - Same operator support as invocation policies
  - Actions:
    - `mark_as_trusted`: Mark data as trusted
    - `block_always`: Prevent data from reaching LLM (blocked data is filtered out before sending to the model)
    - `sanitize_with_dual_llm`: Apply dual LLM sanitization to potentially untrusted data
- **Taint Analysis**: Tracks untrusted data through the system
- **Database Persistence**: All interactions stored in PostgreSQL with direct agent links

#### Database Schema

- **Agent**: Stores AI agents with name and timestamps
- **Interaction**: Stores LLM interactions with request/response data
  - `agentId`: Direct link to the agent (no longer through chat)
  - `provider`: Provider used for the interaction ("openai", "gemini", or "anthropic")
  - `request`: JSONB field storing the full LLM API request (provider-specific format)
  - `response`: JSONB field storing the full LLM API response (provider-specific format)
  - Removed fields: `trusted`, `blocked`, `reason` (trust tracking now handled via policies)
- **Tool**: Stores available tools with metadata
  - Links to agents (for proxy-sniffed tools) or MCP servers (for MCP tools)
  - Security configuration fields removed (moved to AgentTool junction table)
- **AgentTool**: Junction table linking agents to tools with security configuration
  - `allowUsageWhenUntrustedDataIsPresent`: Allow tool to run with untrusted data
  - `toolResultTreatment`: How tool outputs are handled (default: "untrusted"):
    - `"trusted"`: Tool outputs are automatically marked as trusted
    - `"sanitize_with_dual_llm"`: Tool outputs go through dual LLM sanitization before use
    - `"untrusted"`: Tool outputs are marked as untrusted data
- **ToolInvocationPolicy**: Policies for controlling tool usage
  - Links to agent-tool relationships via `agent_tool_id` (not tools directly)
  - Stores argument path, operator, value, action, and reason
- **TrustedDataPolicy**: Policies for marking data as trusted, blocked, or for sanitization
  - Links to agent-tool relationships via `agent_tool_id` (not tools directly)
  - Stores attribute path, operator, value, and action ("mark_as_trusted", "block_always", or "sanitize_with_dual_llm")
- **DualLlmConfig**: Configuration for dual LLM quarantine pattern
  - Stores prompts for main agent, quarantined agent, and summary generation
  - Configures maximum Q&A rounds between agents
- **DualLlmResult**: Stores results from dual LLM executions
  - Links to agent, tool call, and configuration used
  - Stores Q&A conversation, summary, and metadata
- Supports trust tracking and data blocking for security analysis

### Experiments Workspace

The `experiments/` workspace contains prototype features:

#### OpenAI Proxy Server

- Development proxy for intercepting and logging LLM API calls
- Located in `src/main.ts`
- Runs on port 9000 (same as backend, so run one at a time)
- Proxies `/v1/chat/completions`, `/v1/responses`, and `/v1/models`
- Logs all requests/responses for debugging

#### CLI Testing

- `pnpm cli-chat-with-guardrails` - Test the production guardrails via CLI
  - Supports `--agent-id <agent-id>` flag to specify an agent (required)
  - Supports `--provider <provider>` flag to select between "openai", "gemini", or "anthropic" (default: openai)
  - Additional flags: `--include-external-email`, `--include-malicious-email`, `--debug`, `--stream`
- Requires `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY` in `.env` (copy from `.env.example`)

### Code Quality Tools

**Biome** (v2.2.0) is configured at the root level with:

- 2-space indentation
- Automatic import organization on save
- Recommended rules for React and Next.js
- Git integration for change detection
- Scope: All `**/src/**/*.{ts,tsx}` files

### Testing Infrastructure

**Backend Testing** uses Vitest with PGLite for in-memory database testing:

- **Test Runner**: Vitest configured with Node environment
- **Database**: PGLite for in-memory PostgreSQL (no real database needed)
- **Setup**: `test-setup.ts` automatically runs migrations on each test
- **Location**: Test files should be colocated with source files (`.test.ts` extension)
- **Commands**: Run with `pnpm test` from the backend directory or root
- **Globals**: Test utilities are available via `vitest` globals

**Test Examples**:

- `agent.test.ts`: Simple agent CRUD operations
- `tool-invocation-policy.test.ts`: Comprehensive policy evaluation tests
- `trusted-data-policy.test.ts`: Trust evaluation and taint tracking tests

#### Provider Implementation

The platform uses a modular transformer pattern to support multiple LLM providers:

- **Transformer Pattern**: Each provider has a transformer class implementing `ProviderTransformer` interface
  - Transforms between provider-specific formats and common internal format
  - Located in `platform/backend/src/routes/proxy/transformers/`
  - OpenAI transformer: `openai.ts`
  - Gemini transformer: `gemini.ts`
- **Common Format**: Internal representation based on OpenAI's format for consistency
  - Enables unified processing of requests/responses across providers
  - Facilitates security policy evaluation
- **Provider Factory**: Located in `platform/backend/src/routes/proxy/transformers/index.ts`
  - Returns appropriate transformer based on provider type

## Examples

The `platform/examples/` directory contains example integrations:

- **ai-sdk-express**: Express.js server demonstrating integration with AI SDK and Archestra Platform
- **pydantic-ai**: Python CLI chat agent showing Pydantic AI integration with Archestra's security layer
  - Demonstrates autonomous agent with file reading and GitHub issue fetching capabilities
  - Shows how Archestra prevents prompt injection attacks from untrusted sources
  - Includes `--secure` flag to toggle between direct LLM (vulnerable) and Archestra proxy (protected)
  - Supports multiple LLM providers:
    - OpenAI (default): Uses `gpt-4o` by default, configurable via `MODEL_NAME`
    - Anthropic: Uses `claude-sonnet-4-5-20250929` by default, configurable via `MODEL_NAME`
    - Provider selection via `LLM_PROVIDER` environment variable (`openai` or `anthropic`)
  - Example uses GitHub issue #669 which contains a hidden prompt injection attack

Each example includes a README with setup instructions and demonstrates how to use Archestra Platform as a security proxy for LLM applications.

### Coding Conventions

The project follows strict coding conventions to maintain consistency and quality across frontend, backend, and shared code.

#### Frontend Conventions

1. **Component Architecture**
   - Extract pure functions out of components whenever it makes sense
   - Create small, focused components - when using `array.map()`, extract each item into its own component
   - Extract business logic to pure functions or TanStack Query hooks

   ```typescript
   // ✅ Good: Small, focused components
   {items.map(item => <ItemCard key={item.id} item={item} />)}
   
   // ❌ Bad: Inline complex JSX
   {items.map(item => <div>...complex JSX...</div>)}
   ```

2. **Data Fetching**
   - Always use TanStack Query for data fetching
   - Use `useSuspenseQuery` for data fetching in client components
   - Never call HTTP clients directly from client components
   - Prefetch page data on the server and pass as initial data to queries when possible

   ```typescript
   // lib/chat.query.ts
   export function useChatMessages(chatId: string) {
     return useSuspenseQuery({
       queryKey: ['chats', chatId, 'messages'],
       queryFn: () => apiClient.get(`/chats/${chatId}/messages`),
     });
   }
   ```

3. **Error Handling and Loading States**
   - Use error boundaries from components for handling errors
   - Use Suspense for loading states (avoid `loading.tsx` files)

4. **Styling**
   - Use Tailwind CSS 4 utility classes
   - Prioritize applying colors via global theme rather than inline in components
   - Use `bg-primary`, `bg-secondary`, `bg-destructive` instead of hardcoded colors like `bg-blue-500`

5. **State Management**
   - Avoid creating React Context without real need
   - Prefer TanStack Query reused in multiple places to avoid prop drilling
   - For shared data, create a query hook and reuse it across components

6. **UI Components**
   - Always use shadcn/ui components
   - Never use Radix UI directly
   - Add components with `npx shadcn@latest add <component>`

7. **File Organization**
   - **Avoid unnecessary exports** - Only export what needs to be used by other modules. If something is only used within the file, don't export it.
   - **Avoid index and barrel files** - import directly from source files
   - Promote domain/feature file colocation with flat structure
   - Use naming patterns: `chat.query.ts`, `chat.utils.ts`, `chat.hook.ts`, `chat.types.ts`
   - Avoid creating nested folders without need

   ```typescript
   // ❌ Bad: Exporting internal helpers
   export function formatDate(date: Date): string { ... }
   export function UserProfile({ user }: Props) {
     return <div>{formatDate(user.createdAt)}</div>;
   }

   // ✅ Good: Only export what's needed externally
   function formatDate(date: Date): string { ... }  // Internal helper
   export function UserProfile({ user }: Props) {   // Public API
     return <div>{formatDate(user.createdAt)}</div>;
   }
   ```

   ```
   ✅ Good: Flat structure
   lib/
   ├── chat.query.ts
   ├── chat.utils.ts
   ├── chat.hook.ts
   └── user.query.ts
   
   ❌ Bad: Unnecessary nesting
   lib/chat/queries/use-chat-messages.ts
   lib/chat/utils/format-message.ts
   ```

#### Backend Conventions

1. **File Organization**
   - **Avoid unnecessary exports** - Only export what needs to be used by other modules. If something is only used within the file, don't export it.
   - **Avoid index and barrel files** - use direct imports
   - **Avoid nested folder structure** - keep it flat
   - Promote domain/feature file colocation
   - Colocate test files with source files (`.test.ts` extension)

   ```typescript
   // ❌ Bad: Exporting internal helpers
   export function validateAgentName(name: string): boolean { ... }
   export async function createAgent(data: CreateAgentInput) { ... }

   // ✅ Good: Only export public API
   function validateAgentName(name: string): boolean { ... }  // Internal
   export async function createAgent(data: CreateAgentInput) { ... }  // Public
   ```

   ```
   ✅ Good: Flat structure
   models/
   ├── agent.ts
   ├── agent.test.ts
   ├── chat.ts
   └── chat.test.ts
   
   ❌ Bad: Unnecessary nesting
   models/agent/crud/create.ts
   models/agent/queries/get-by-id.ts
   ```

2. **Database Operations**
   - Use Drizzle ORM for all database operations
   - Never use raw SQL unless absolutely necessary
   - Use parameterized queries to prevent SQL injection
   - Return results from `.returning()` for insert/update operations

3. **Testing**
   - Use Vitest with PGLite for in-memory database testing
   - Colocate test files with source (`.test.ts` extension)
   - Test all CRUD operations and edge cases

#### Shared Workspace Conventions

- Common/reusable code needed by both frontend and backend should be placed in the `/shared` pnpm workspace
- Only put truly shared, environment-agnostic code in `shared/`
- Examples: TypeScript types, Zod validation schemas, constants, API client types
- Don't put frontend-specific (React) or backend-specific (Fastify, database) code in `shared/`

```typescript
// shared/types/agent.types.ts
export interface Agent {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### Development Best Practices

- Use existing patterns and libraries - check neighboring files for examples
- Follow existing naming conventions (camelCase for TypeScript)
- Test files should be colocated with source (`.test.ts` extension)
- Use workspace-relative imports within each workspace
- Run `pnpm type-check` before committing to catch type errors
- Use `tilt up` for the best development experience with hot reload

### Performance Benchmarking

The platform includes performance benchmarking infrastructure for measuring platform overhead:

- **Location**: `platform/benchmarks/`
- **Purpose**: Measure platform performance in mock mode (without real LLM API calls)
- **Infrastructure**: Uses GCP VMs for isolated, reproducible benchmarks
- **Load Testing**: Apache Bench-based load testing with configurable concurrency

#### Benchmark Setup

1. **Configure Environment**:
   ```bash
   cd platform/benchmarks
   cp .env.example .env
   # Edit .env with your GCP project settings
   ```

2. **Run Benchmarks**:
   ```bash
   ./setup-gcp-benchmark.sh    # Provision GCP infrastructure
   ./run-benchmark.sh          # Execute benchmarks
   ./cleanup-gcp-benchmark.sh  # Clean up resources
   ```

3. **Test Scenarios**:
   - Simple chat completions
   - Chat with tool invocations
   - Both scenarios use mock responses to isolate platform overhead

4. **Metrics Collected**:
   - Throughput (requests/second)
   - Latency percentiles (p50, p95, p99)
   - Error rates
   - Time per request statistics

See `platform/benchmarks/README.md` for detailed documentation.

### Release Process

The platform uses [release-please](https://github.com/googleapis/release-please) for automated release management:

- **Version**: Currently at v0.0.0 (initial version)
- **Release PRs**: Automatically created when conventional commits are merged
- **Platform Releases**: When a platform release is merged:
  1. Docker image is built and published to DockerHub (archestra/platform)
  2. Helm chart is published to Google Artifact Registry
- **Changelog**: Maintained in `platform/CHANGELOG.md`
- **Release Configuration**: See `.github/release-please/release-please-config.json`
- **Release Manifest**: See `.github/release-please/.release-please-manifest.json`

### Release Workflow Details

The release process is triggered automatically when:

1. Conventional commits are merged to main
2. Release-please creates a PR with version bumps
3. When the release PR is merged, the following happens:
   - Platform Docker image is built from `platform/` directory
   - Image is pushed to DockerHub with the new version tag
   - Helm chart (from `platform/helm/`) is packaged and pushed to GAR

The release workflow (`release-please.yml`) monitors both `desktop_app` and `platform` packages:

- Outputs separate release states: `platform_release_created` and `desktop_release_created`
- Platform releases trigger:
  - `build-and-push-platform-docker-image-to-dockerhub` job
  - `publish-platform-helm-chart` job
- Desktop releases remain unchanged

#### Docker Image Publishing

The platform Docker image is published to DockerHub:

- **Repository**: `archestra/platform`
- **Build Context**: `./platform` directory
- **Triggered by**: Platform releases from release-please
- **Version Tags**: Uses the platform version from release-please output
- **Workflow**: `.github/workflows/build-dockerhub-image.yml`
- **Authentication**: Requires `DOCKER_USERNAME` and `DOCKER_PASSWORD` secrets
- **Build Features**:
  - Multi-stage builds supported via Dockerfile
  - Optional push based on workflow inputs

#### Helm Chart

The platform includes a simplified Helm chart for Kubernetes deployments:

- **Location**: `platform/helm/`
- **Chart Name**: archestra-platform
- **Version**: 0.0.1 (managed by release-please)
- **Architecture**:
  - Single consolidated template (`archestra-platform.yaml`) containing both Service and Deployment
  - Simplified values structure focused on essential configuration
  - Supports both internal PostgreSQL deployment (via Bitnami chart) or external database
  - Init container to wait for PostgreSQL readiness before starting the application
- **Core Features**:
  - Single container deployment running both backend (port 9000) and frontend (port 3000)
  - ClusterIP Service exposing both ports
  - PostgreSQL dependency (Bitnami chart v18.0.8) with option for external database
  - Environment variable injection for database connectivity
  - Default image: `archestra/platform:latest`
  - Automatic PostgreSQL connection waiting via init container
- **Installation**:
  ```bash
  helm upgrade archestra-platform ./helm \
    --install \
    --namespace archestra-dev \
    --create-namespace \
    --wait
  ```
- **Configuration**:
  - `archestra.image`: Docker image to deploy (default: `archestra/platform:latest`)
  - `archestra.env`: Optional environment variables to inject (default: empty object `{}`)
    - Example: `archestra.env.ARCHESTRA_API_BASE_URL: "https://api.example.com"`
    - The default deployment no longer includes hardcoded API URL environment variables
  - `postgresql.external_database_url`: Optional external database URL (format: `postgresql://username:password@host:5432/database`)
  - `postgresql.*`: Bitnami PostgreSQL chart configuration when using internal database
    - Uses `bitnamisecure/postgresql:latest` image due to Bitnami repository changes
    - Default database: `archestra_dev`
    - Default username: `archestra`
- **Publishing**:
  - **Repository**: `oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts`
  - **Authentication**: Google Artifact Registry via Workload Identity Federation
  - **Workflow**: `.github/workflows/publish-platform-helm-chart.yml`
- **Testing**:
  - Helm lint validation in CI
  - Comprehensive helm-unittest tests in `tests/archestra_platform_test.yaml`
  - Tests validate container configuration, ports, environment variables, and service setup
