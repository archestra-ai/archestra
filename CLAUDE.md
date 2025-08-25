# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Directory

**ALWAYS run all commands from the `desktop_app/` directory unless specifically instructed otherwise.**

Note: The README.md includes a Developer Quickstart section that shows basic setup steps. When following those instructions, ensure you're in the `desktop_app/` directory for all commands after cloning.

## Important Rules

1. **NEVER modify files in `src/ui/components/ui/`** - These are shadcn/ui components and should remain unchanged
2. **ALWAYS use pnpm** (not npm or yarn) for package management
3. **Run database commands from `desktop_app/`** directory
4. **Use Podman** (not Docker) for container operations

## Common Development Commands

### Running the Application

```bash
cd desktop_app
pnpm start              # Start development app
pnpm start:server       # Start backend server only
```

### Building & Packaging

```bash
cd desktop_app
pnpm package           # Package app for current platform
pnpm make             # Create platform installer
pnpm build:universal  # Build universal macOS binary
```

### Testing & Code Quality

```bash
cd desktop_app
pnpm test             # Run all tests
pnpm test:ui          # Run UI tests only
pnpm test:backend     # Run backend tests only
pnpm typecheck        # Check TypeScript types
pnpm prettier         # Format code
```

### Database Management

```bash
cd desktop_app
pnpm db:studio        # Open Drizzle Studio GUI
pnpm db:migrate       # Run database migrations
pnpm db:push          # Push schema changes (dev only)
```

### API Documentation

```bash
cd desktop_app
pnpm generate:openapi-clients  # Generate TypeScript clients from OpenAPI specs
```

## High-Level Architecture

### Overview

Archestra is an enterprise-grade Model Context Protocol (MCP) platform built as a privacy-focused Electron desktop application. It provides a secure runtime environment for AI agents with local-first architecture.

### Tech Stack

- **Frontend**: React 19 + TypeScript + Tailwind CSS + shadcn/ui
- **Desktop**: Electron 37.2.5 with Electron Forge
- **Backend**: Fastify server running in separate process
- **Database**: SQLite with Drizzle ORM (snake_case naming)
- **State Management**: Zustand stores
- **Routing**: Tanstack Router with file-based routing
- **Build**: Vite with separate configs for each process
- **Containerization**: Podman for sandboxing

### Process Architecture

1. **Main Process** (`src/main.ts`): Electron main process handling windows and IPC
2. **Renderer Process** (`src/renderer.tsx`): React UI application
3. **Server Process** (`src/server-process.ts`): Fastify backend server (port 2024)
4. **Preload Script** (`src/preload.ts`): Secure bridge between renderer and main

### Key Features

- **PodmanRuntime**: Manages Podman machine lifecycle
  - Automatic machine creation and startup
  - Dynamic socket path resolution (avoids Docker/Orbstock conflicts)
  - Multi-platform binary distribution (Linux, macOS, Windows)
  - Enhanced progress tracking with percentage-based reporting
  - Combined progress calculation (50% machine startup + 50% image pull)
  - Progress parsing utilities for real-time output processing
- **McpServerSandboxManager**: High-level orchestration of MCP servers
  - Base image management (`europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.1`)
  - Manages multiple `SandboxedMcpServer` instances
  - WebSocket progress broadcasting with detailed status updates
  - Comprehensive `statusSummary` getter combining runtime and container statuses
  - Tools aggregation across all servers (`getAllTools()`, `getToolsById()`)
- **SandboxedMcpServer**: Individual MCP server management
  - MCP client lifecycle management using AI SDK's `experimental_createMCPClient`
  - Automatic tools discovery and caching from connected servers
  - Tool ID transformation to format: `<mcp_server_id>__<tool_name>` (double underscore separator)
  - Container integration with health monitoring
  - JSON-serializable schema processing for tool inputs
  - Status reporting and container log access
- **Progress Tracking Architecture**:
  - Hierarchical progress system: Runtime → Image → Container levels
  - Real-time progress parsing from Podman machine installation output
  - Detailed percentage mapping for each stage (0-5% lookup, 5-60% download, etc.)
  - Type-safe status schemas using Zod validation
- **Container Management**: Enhanced container lifecycle tracking
  - Multiple container states: `not_created`, `created`, `initializing`, `running`, `error`
  - Percentage-based progress tracking (0-100%) through container lifecycle
  - Human-readable status messages for each stage of container startup
  - Detailed error reporting for different failure scenarios
  - MCP socket connection pooling and management
- **Image Management**: Streaming progress during base image operations
  - Real-time progress tracking during image pull with percentage completion
  - Stage-specific messages (resolving, copying blobs, writing manifest)
  - Proper error capture and reporting during image operations
  - Progressive percentage calculation based on blob count
- **UI Progress Components**:
  - Real-time progress bars in MCP server settings
  - Status badges (Connecting/Connected/Error) with color coding
  - Loading states with spinner animations
  - Error display with detailed messages
- **Logging and Debugging**:
  - **Container Logs**: Persistent MCP server log files with automatic rotation
    - Log files stored in `~/Library/Application Support/archestra/logs/<container-name>.log`
    - **Automatic Log Rotation**: Using `rotating-file-stream` library
      - Configurable max file size (default: 5MB, env var: `MCP_SERVER_LOG_MAX_SIZE`)
      - Configurable max files to keep (default: 2, env var: `MCP_SERVER_LOG_MAX_FILES`)
      - Rotated files use numeric suffixes: `<container-name>.log`, `<container-name>.log.1`, `<container-name>.log.2`, etc.
      - Custom filename generator ensures consistent numeric suffix pattern
      - No compression applied for easier access to rotated logs
    - Real-time streaming from container stdout/stderr to log files
    - Multiplexed stream processing handles Podman's 8-byte header format
    - Session markers with timestamps for each container start
    - Append mode preserves historical logs across container restarts
    - **Enhanced Log Reading**: `getRecentLogs()` reads from all rotated files
      - Automatically finds and sorts all log files (main + rotated)
      - Reads files in chronological order (newest first)
      - Efficiently collects requested number of lines across multiple files
      - Graceful error handling for missing or inaccessible files
    - **Cleanup on Uninstall**: Complete removal of all log files (including rotated versions)
      - Pattern-based file matching to find all related log files
      - Safe cleanup with individual file error handling
      - Integrated with container removal process
    - UI dialog for viewing container logs (accessible via FileText icon in MCP server settings)
    - Terminal-style log viewer with black background and green monospace text
    - Manual refresh functionality with loading states
    - API endpoint: `GET /mcp_proxy/:id/logs?lines=100` for retrieving recent logs from all rotated files
    - `cleanupLogFiles()` method for removing all log files when uninstalling servers
  - **Request Logging**: Comprehensive MCP request/response tracking in database
    - Unique UUID for each request with timing metrics
    - Captures method, headers, body, status codes, duration, and errors
    - Client information tracking (user agent, platform, version)
    - Session correlation with MCP session IDs
    - Advanced filtering by server, method, status, date range
    - Analytics dashboard with statistics (total requests, success rate, avg duration)
    - Automatic cleanup of logs older than 7 days (configurable)
    - API endpoints:
      - `GET /api/mcp_request_log` - Paginated log retrieval with filtering
      - `GET /api/mcp_request_log/:id` - Individual log entry access
      - `GET /api/mcp_request_log/stats` - Analytics and statistics
      - `DELETE /api/mcp_request_log` - Log cleanup endpoint
  - **Centralized Path Management**: Shared paths utility (`src/backend/utils/paths.ts`)
    - `USER_DATA_DIRECTORY`: Application data storage (from `ARCHESTRA_USER_DATA_PATH`)
    - `LOGS_DIRECTORY`: Log file storage (from `ARCHESTRA_LOGS_PATH`)
    - `DATABASE_PATH`: SQLite database location
    - `PODMAN_REGISTRY_AUTH_FILE_PATH`: Podman authentication file
    - Environment variables set by main process for backend access
    - Fallback to `/tmp` for codegen scenarios when env vars not set
- **Security Features**:
  - Non-root container execution (uid: 1000, gid: 1000)
  - Process isolation per MCP server
  - stdin/stdout communication only (no exposed ports)
  - Minimal base image with only essential dependencies
- **User Management**:
  - Centralized user settings and preferences
  - Onboarding flow tracking with `has_completed_onboarding` field
  - Telemetry opt-in functionality with `collect_telemetry_data` field
  - Automatic user record creation on application startup via `ensureUserExists()`
  - Primary API endpoints:
    - `GET /api/user` - Returns complete user object
    - `PATCH /api/user` - Allows partial updates (hasCompletedOnboarding, collectTelemetryData, etc.)
  - Legacy API endpoints (maintained for backward compatibility):
    - `GET /api/onboarding/status` - Returns onboarding completion status
    - `POST /api/onboarding/complete` - Marks onboarding as complete
  - Zustand store for frontend state management (`user-store.ts`)
- **Tool Selection and Discovery**:
  - Browse and select specific MCP tools for chat conversations
  - Tool discovery via `GET /api/mcp_server/tools` endpoint
  - Real-time tool list updates as servers connect/disconnect via WebSocket
  - Tools organized by MCP server for better UX
  - Selected tools displayed as pills in chat interface
  - Chat store management with `selectedTools` and `toolChoice` state
  - Selective tool execution - LLM only uses selected tools instead of all available
  - **Enhanced Tools Architecture**:
    - Individual `SandboxedMcpServer` instances handle tool discovery
    - Tools cached after MCP client connection
    - Tool schemas cleaned for JSON serialization (symbol removal)
    - Tools available in two formats:
      - AI SDK format: `McpTools` for LLM execution
      - UI format: `AvailableTool` with rich metadata
  - Unique tool identification format: `{serverId}:{toolName}`
  - Dynamic tool rendering in assistant messages with execution states
  - WebSocket broadcasts include tools in sandbox status updates
  - **Tool Analysis**: Automatic analysis of tool properties using Ollama
    - Uses `phi3:3.8b` model to analyze each tool's characteristics
    - Analyzes tools for: `is_read`, `is_write`, `idempotent`, `reversible` properties
    - Analysis performed when new tools are discovered
    - Results stored in database and displayed in ToolHoverCard UI
    - Batch processing (10 tools at a time) for performance
    - Graceful fallback if analysis fails - tools still saved without analysis
    - Re-analysis capability for unanalyzed tools
    - Analysis results enhance user understanding of tool capabilities and risks
- **LLM Provider Support**:
  - **Cloud Providers**: Anthropic, OpenAI, Google Gemini
  - **Local Providers**: Ollama for running models locally
  - **Ollama Integration**:
    - Uses `ollama-ai-provider-v2` package for AI SDK compatibility
    - No API key required for local operation
    - Base URL constructed from `config.ollama.server.host + '/api'`
    - Supported models: Llama 3.2, Llama 3.1, Mistral, Mixtral, CodeLlama, Phi3
    - Special handling in `llm/index.ts` to bypass standard provider validation
    - Provider type: `'ollama'` in the provider registry
    - Known limitation: Some MCP tool calls may not work correctly
- **Routing System** (Tanstack Router):
  - File-based routing with automatic route generation
  - Type-safe navigation with `@tanstack/react-router`
  - Route tree automatically generated at `src/ui/routeTree.gen.ts`
  - Routes defined in `src/ui/routes/` directory
  - Layout route at `__root.tsx` provides sidebar wrapper
  - Nested routes for settings and LLM providers
  - Auto code-splitting enabled for better performance
  - Development tools available via `TanStackRouterDevtools`
- **Ollama Integration**:
  - **Automatic Server Management**: Launches bundled Ollama server (v0.11.4) on startup
    - Runs locally on configurable port (default: 54589, env var: `ARCHESTRA_OLLAMA_SERVER_PORT`)
    - Graceful startup/shutdown with process lifecycle management
    - CORS configuration for API access
  - **Model Management**: Automatic provisioning of required models
    - Required models: `llama-guard3:1b` (safety checks), `phi3:3.8b` (general tasks)
    - Parallel model downloads on first startup
    - Real-time progress tracking via WebSocket (`ollama-model-download-progress`)
    - Graceful error handling - continues operation if downloads fail
  - **API Client** (`src/backend/ollama/client.ts`):
    - Full Ollama API support with TypeScript/Zod validation
    - Methods: `generate()`, `pull()`, `list()`, `generateChatTitle()`, `analyzeTools()`
    - Streaming support for model downloads and generation
    - Automatic retry logic for server connectivity
    - `analyzeTools()`: Analyzes MCP tools for read/write, idempotent, and reversible properties
  - **API Endpoints**:
    - `GET /api/ollama/required-models` - Check model installation status
    - `/llm/ollama/*` - Proxy routes to local Ollama server
  - **UI Integration**:
    - Settings page at `/settings/ollama` with installation status
    - Real-time progress bars during model downloads
    - Color-coded status badges (Installed/Downloading/Not Installed)
    - Error state handling with descriptive messages
  - **Configuration** (`config.ts`):
    - Server settings: host, port, CORS origins
    - Required models list for auto-provisioning
    - Default model selection (`OLLAMA_MODEL` env var)
- **OAuth Integration**:
  - **Architecture**: Two-tier system with OAuth proxy (secrets) and desktop app (PKCE)
    - OAuth Proxy: `oauth_proxy/` - Holds client secrets, exchanges codes
    - Desktop App: Initiates OAuth flows, stores tokens as env vars
    - Production proxy: `https://oauth-proxy-new-354887056155.europe-west1.run.app`
  - **Extensible Provider System** (`src/backend/config/oauth-providers.ts`):
    - Provider registry pattern with standardized configuration
    - Supports OAuth, browser auth, and file-based credentials
    - Provider interface: `OAuthProviderDefinition`
    - Token mapping via `tokenEnvVarPattern` or custom `tokenHandler`
  - **Supported Providers**:
    - **Google**: OAuth with file-based credentials option
    - **Slack**: OAuth + browser auth (`slack-browser` provider)
    - Extensible for Jira, LinkedIn, MS Teams, etc.
  - **Browser Authentication** (`src/main-browser-auth.ts`):
    - Extract tokens directly from provider web UI
    - Secure Electron BrowserWindow with sandboxing
    - Provider-specific token extraction logic
    - Maps to same env vars as OAuth tokens
  - **MCP Server Catalog Integration**:
    - Catalog defines provider in `archestra_config.oauth.provider`
    - UI auto-detects and triggers appropriate auth flow
    - Browser auth mapped via `useBrowserAuth` flag
  - **API Endpoints**:
    - `POST /api/mcp_server/start_oauth` - Start OAuth with PKCE
    - `POST /api/mcp_server/complete_oauth` - Complete OAuth flow
    - `POST /api/mcp_server/install` - Install with OAuth tokens
  - **Token Storage**:
    - Database: `oauth_access_token`, `oauth_refresh_token`, `oauth_expiry_date`
    - Environment vars: Provider-specific patterns (e.g., `SLACK_MCP_XOXC_TOKEN`)
    - File-based: Custom handlers for providers like Google
  - **Adding New Providers**: See `docs/ADDING_OAUTH_PROVIDERS.md`

### Directory Structure

```
desktop_app/src/
├── backend/
│   ├── clients/        # API clients (Podman integration)
│   ├── database/       # SQLite schema and migrations
│   ├── llms/          # LLM integrations (cloud providers)
│   ├── mcpServer/     # MCP server implementation
│   ├── models/        # Data models
│   ├── ollama/        # Ollama local LLM integration
│   ├── sandbox/       # Container sandboxing logic
│   │   ├── manager/   # McpServerSandboxManager
│   │   └── sandboxedMcp/ # SandboxedMcpServer class
│   ├── server/        # Fastify server and plugins
│   └── utils/         # Utility functions (paths, binaries, etc.)
└── ui/
    ├── components/    # React components (don't modify ui/ subdirectory)
    ├── pages/        # Application pages (being phased out)
    ├── routes/       # Tanstack Router file-based routes
    ├── stores/       # Zustand state stores
    └── hooks/        # Custom React hooks

oauth_proxy/
├── src/
│   ├── app.js         # Express app configuration
│   ├── server.js      # Server entry point
│   ├── config/        # Configuration and environment
│   ├── providers/     # OAuth provider implementations
│   │   ├── base.js    # Base OAuth provider class
│   │   ├── google.js  # Google OAuth specifics
│   │   └── slack.js   # Slack OAuth specifics
│   └── routes/        # API routes
│       ├── callback.js # OAuth callback handler
│       └── token.js    # Token exchange endpoint
└── package.json       # Dependencies and scripts
```

### Database Schema

Key tables (snake_case naming):

- `chats`, `messages`: Conversation storage
- `cloud_providers`: LLM provider configurations
- `mcp_servers`: Installed MCP servers
- `mcp_request_logs`: MCP activity logging
  - Tracks all MCP API requests and responses
  - Includes timing, status codes, headers, and payloads
  - Links to sessions and servers for comprehensive debugging
- `external_mcp_clients`: External MCP client configurations
- `user`: Application user settings
  - `has_completed_onboarding`: Tracks onboarding completion status
  - `collect_telemetry_data`: Stores telemetry opt-in preferences
  - Auto-created on application startup via `ensureUserExists()`
- `tools`: MCP tool metadata and analysis results
  - Primary key: `{mcp_server_id}__{tool_name}` (double underscore separator)
  - Foreign key to `mcp_servers` with cascade delete
  - Stores tool name, description, and input schema
  - Analysis results: `is_read`, `is_write`, `idempotent`, `reversible` (nullable booleans)
  - Timestamps: `analyzed_at`, `created_at`, `updated_at`

### API Patterns

- **REST API**: Fastify server on port 2024
- **WebSocket**: Real-time communication for streaming responses
- **IPC**: Electron IPC for main-renderer communication
- **OpenAPI Schema Generation**: The project uses `@fastify/swagger` to automatically generate OpenAPI specifications from Fastify route schemas
- **TypeScript Client Generation**: Uses `@hey-api/openapi-ts` to generate fully-typed TypeScript clients from OpenAPI specs
  - External link handling: Use `window.electronAPI.openExternal(url)` to open URLs in the default browser
  - Implementation: IPC handler in main process (`ipcMain.handle('open-external')`) uses `shell.openExternal`
  - Security: URLs should be validated or hardcoded; user input should not be passed directly
- **Generated Clients**: TypeScript clients from OpenAPI specs in `openapi/`
  - Run `pnpm codegen:archestra:api` to regenerate API spec and TypeScript client after adding/modifying endpoints
  - Generated clients are located in `desktop_app/src/ui/lib/clients/archestra/api/gen/`
  - All Zod schemas should be registered in the global registry for OpenAPI component generation using `z.globalRegistry.add(Schema, { id: 'SchemaName' })`

### MCP Server Management

- Servers installed to `~/Library/Application Support/archestra/mcp-servers/`
- Python servers use virtual environments
- Node.js servers use local node_modules
- Container-based execution with Podman

### Testing Patterns

- **Vitest** for all tests
- UI tests use jsdom environment
- Backend tests use node environment
- Test files colocated with source files (`.test.ts` extension)

### CI/CD Workflows

- **Linting and Tests**: Automated code quality checks
- **Build Desktop Application**: Multi-platform builds
- **Release Please**: Automated versioning and changelog
- **Claude Integration**: AI-powered PR reviews
  - **User-Scoped Authentication**: Each authorized user has their own Claude OAuth token
  - **Workflow Structure**:
    - `claude-code.yml` and `claude-pull-requests.yml`: Reusable workflow templates
    - `user-scoped-claude-code.yml` and `user-scoped-claude-pull-requests.yml`: User-specific orchestrators
  - **Authorized Users**: Currently configured for `joeyorlando`, `Matvey-Kuk`, and `iskhakov`
  - **Compliance**: Ensures adherence to Anthropic's single-account OAuth token policy
  - **Adding New Users**: Add repository secret `USERNAME_CLAUDE_CODE_OAUTH_TOKEN` and update user-scoped workflows

### Development Notes

- Database file: `~/Library/Application Support/archestra/archestra.db`
- Logs directory: `~/Library/Application Support/archestra/logs/`
  - MCP server logs: `~/Library/Application Support/archestra/logs/<container-name>.log`
- Binary resources: `desktop_app/resources/bin/` (platform-specific)
- OAuth proxy server: `oauth_proxy/` (top-level directory)
- Code signing configured for macOS notarization
- ASAR packaging enabled for production builds

### macOS Code Signing

For macOS builds, the following environment variables are required:

- `APPLE_ID`: Apple ID email associated with your developer account
- `APPLE_PASSWORD`: App-specific password (generate at https://support.apple.com/102654)
- `APPLE_TEAM_ID`: Apple Team ID from https://developer.apple.com/account/#/membership
- `APPLE_CERTIFICATE_PASSWORD`: Password for the signing certificate

The build process automatically handles certificate installation and keychain cleanup.
