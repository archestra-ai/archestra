# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Directory

**ALWAYS run all commands from the `desktop_app/` directory unless specifically instructed otherwise.**

**Exceptions:**
- When working on experiments, run commands from the `platform/experiments/` directory.
- When working on the platform backend, run commands from the `platform/` directory.

## Important Rules

1. **NEVER modify files in `src/ui/components/ui/`** - These are shadcn/ui components and should remain unchanged
2. **ALWAYS use pnpm** (not npm or yarn) for package management
3. **Format code with Prettier** - Run `pnpm prettier --write .` before committing changes
4. **TypeScript strict mode** - Ensure code passes `pnpm typecheck` before completion

## Common Development Commands

### Running the Application

```bash
pnpm start              # Start development app (Electron with hot reload)

# For free LLM access via archestra-llm:
# The archestra-llm model is available by default and routes to the configured archestra.websiteUrl/api/llm-proxy/gemini
# You'll need to set up a separate proxy service that handles Google AI Studio API authentication
```

### Testing

```bash
pnpm test               # Run all unit and integration tests with Vitest
pnpm test:e2e:packaged  # Run E2E tests on packaged application
```

### Building & Packaging

```bash
pnpm package          # Package app for current platform
pnpm make             # Create platform installer (DMG, DEB, RPM, etc.)
```

### Code Quality

```bash
pnpm typecheck                  # Check TypeScript types
pnpm prettier --write .         # Format all code with Prettier
```

### Database Management

```bash
pnpm db generate  # Generate database migration files from schema changes
pnpm db push      # Apply migrations to development database
pnpm db studio    # Open Drizzle Studio for database inspection
```

### Code Generation

```bash
pnpm codegen:all                # Generate all API clients and types
pnpm codegen:archestra:api      # Generate Archestra API client from OpenAPI spec
pnpm codegen:archestra:catalog  # Generate catalog API client
pnpm codegen:libpod            # Generate Podman API client
```

## High-Level Architecture

### Overview

Archestra is an enterprise-grade Model Context Protocol (MCP) platform built as a privacy-focused Electron desktop application. It provides a secure runtime environment for AI agents with local-first architecture and sandboxed execution using Podman containers.

### Core Tech Stack

- **Frontend**: React 19 + TypeScript + Tailwind CSS + shadcn/ui components
- **Desktop**: Electron 37.3.5 with Electron Forge
- **Backend**: Fastify server running in main process (port 2024)
- **Database**: SQLite with Drizzle ORM (snake_case naming convention)
- **State Management**: Zustand stores for UI state
- **Routing**: Tanstack Router with file-based routing
- **Build System**: Vite with separate configs for main/renderer/preload
- **Container Runtime**: Podman for MCP server sandboxing
- **Testing**: Vitest for unit/integration tests, WebDriverIO for E2E tests

### Process Architecture

1. **Main Process** (`src/main.ts`):

   - Electron main process handling windows and IPC
   - Hosts the Fastify backend server
   - Manages Ollama server lifecycle
   - Handles OAuth flows and external URL opening

2. **Renderer Process** (`src/renderer.tsx`):

   - React UI application
   - Communicates with backend via HTTP/WebSocket

3. **Preload Script** (`src/preload.ts`):
   - Secure bridge for IPC communication
   - Exposes limited APIs to renderer

### Key Architectural Components

#### MCP Server Management

- **McpServerSandboxManager**: Orchestrates multiple MCP servers

  - Base image: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.2`
  - WebSocket broadcasting for real-time status updates
  - Tool discovery and management across all servers

- **SandboxedMcpServer**: Individual MCP server instances

  - Uses AI SDK's `experimental_createMCPClient` for MCP protocol
  - Tool ID format: `{mcp_server_id}__{tool_name}` (double underscore)
  - Container-based isolation with Podman
  - Automatic tool discovery and caching

- **PodmanRuntime**: Container runtime management
  - Automatic Podman machine creation/startup
  - Dynamic socket path resolution (avoids conflicts)
  - Multi-platform binary distribution
  - Real-time progress tracking with percentages

- **ToolService**: Unified tool management and approval system
  - Aggregates tools from all MCP servers (sandboxed + Archestra)
  - Human-in-the-loop approval workflow for write operations
  - Session-level approval rules with "always approve/decline" options
  - Tool wrapping with approval logic integration

#### Database Schema (Snake Case)

Key tables:

- `chats`, `messages`: Conversation storage
- `mcp_servers`: Installed MCP server configurations
- `tools`: MCP tool metadata with analysis results
- `user`: User settings (onboarding, telemetry preferences)
- `mcp_request_logs`: Request/response logging for debugging
- `cloud_providers`: LLM provider configurations

#### API Architecture

- **REST API**: Fastify server with auto-generated OpenAPI specs
- **WebSocket**: Real-time updates for streaming, progress, and status
- **IPC**: Electron IPC for main-renderer communication
- **TypeScript Clients**: Generated from OpenAPI specs using `@hey-api/openapi-ts`

#### LLM Integration

- **Cloud Providers**: Anthropic, OpenAI, Google Gemini, DeepSeek
- **Local Provider**: Ollama with bundled server (v0.12.1)
  - Auto-downloads required models: `llama-guard3:1b`, `phi3:3.8b`
  - Tool analysis using local models
  - Configurable port (default: 54589)
- **Free LLM Option**: "archestra-llm" model
  - Proxies requests to Google Gemini (gemini-2.5-pro) via configurable proxy
  - Requires external proxy service at {archestra.websiteUrl}/api/llm-proxy/gemini
  - No API key configuration needed in Archestra (handled by proxy)
  - Authentication: Session token sent as Bearer token in Authorization header

### Directory Structure

```
desktop_app/
├── src/
│   ├── backend/
│   │   ├── archestraMcp/   # MCP protocol implementation
│   │   ├── clients/        # API clients (Podman, etc.)
│   │   ├── database/       # SQLite schema and migrations
│   │   ├── models/         # Data models
│   │   ├── ollama/         # Ollama integration
│   │   ├── sandbox/        # Container sandboxing
│   │   ├── server/         # Fastify server and plugins
│   │   ├── services/       # Business logic services (e.g., ToolService)
│   │   └── utils/          # Utilities (paths, binaries)
│   └── ui/
│       ├── components/     # React components (DON'T modify ui/ subdirectory)
│       ├── routes/         # Tanstack Router file-based routes
│       ├── stores/         # Zustand state management
│       └── hooks/          # Custom React hooks
├── resources/
│   └── bin/               # Platform-specific binaries (Podman, Ollama)
└── openapi/               # OpenAPI specs and generated clients

platform/
└── experiments/           # Experimental features and prototypes
    ├── src/
    │   ├── guardrails/    # Security guardrails implementation
    │   └── main.ts        # OpenAI proxy server
    └── README.md          # Experiments documentation
```

### Development Best Practices

- Use existing patterns and libraries - check neighboring files for examples
- Follow existing naming conventions (snake_case for database, camelCase for TypeScript)
- All Zod schemas must be registered: `z.globalRegistry.add(Schema, { id: 'SchemaName' })`
- Test files colocated with source (`.test.ts` extension)
- Use absolute imports: `@backend/...` and `@ui/...`

### Important File Locations

- Database: `~/Library/Application Support/archestra/archestra.db`
- Logs: `~/Library/Application Support/archestra/logs/`
- MCP Servers: `~/Library/Application Support/archestra/mcp-servers/`
- Container logs: `~/Library/Application Support/archestra/logs/<container-name>.log`

### macOS Code Signing

For production builds, these environment variables are required:

- `APPLE_ID`: Developer account email
- `APPLE_PASSWORD`: App-specific password
- `APPLE_TEAM_ID`: Team ID from developer account
- `APPLE_CERTIFICATE_PASSWORD`: Certificate password

### Deep Linking

Archestra supports deep linking for OAuth authentication flows:

- **OAuth Callback**: `archestra-ai://oauth-callback?code=<auth_code>&state=<state>`
  - Handles OAuth authorization codes from external providers
  - Forwards the code to backend server for token exchange via `/api/oauth/store-code` endpoint
  - Sends to backend on port 54587 (configurable via `ARCHESTRA_API_SERVER_PORT`)
  
- **Auth Success**: `archestra-ai://auth-success?token=<auth_token>`
  - Stores authentication tokens in the CloudProvider model for 'archestra' provider
  - Broadcasts `user-authenticated` events via WebSocket
  - Automatically focuses the application window

**Implementation Notes**:
- Deep link handler is in `src/deep-linking.ts`
- Auth tokens are stored in the `cloud_providers` table (not user table)
- WebSocket broadcasts notify UI of authentication status changes

### Experiments Platform

The `platform/experiments/` directory contains experimental features and prototypes:

#### OpenAI Proxy Server
- Development proxy server for intercepting and logging LLM API calls
- Located in `src/main.ts`
- Runs on port 9000 by default
- To use in desktop app, uncomment line 56 in `desktop_app/src/backend/server/plugins/llm/index.ts`

#### Security Guardrails
- Advanced security features in `src/guardrails/`:
  - **Dual LLM Pattern**: Quarantined + privileged LLMs for prompt injection detection
  - **Tool Invocation Policies**: Fine-grained control over tool usage
  - **Taint Analysis**: Tracks untrusted data through the system
- CLI testing interface: `pnpm cli-chat-with-guardrails`

#### Running Experiments
```bash
cd platform/experiments
pnpm install
cp .env.example .env      # Configure OPENAI_API_KEY
pnpm proxy:dev           # Start proxy server (port 9000)
pnpm cli-chat-with-guardrails  # Test guardrails CLI
```

### Platform Development

When working on the platform backend:

```bash
cd platform/
pnpm install
# Tilt will automatically create .env from .env.example if it doesn't exist
tilt up
```

**Development Features:**
- **Tilt Integration**: Manages PostgreSQL, migrations, and dev servers
- **Auto-linting**: The `lint:fix` resource watches files and auto-fixes issues
- **VS Code Support**: Platform has its own VS Code settings for optimal DX
  - Auto-formatting with Biome
  - Git support when opening platform/ as a workspace
  - TypeScript project diagnostics enabled
