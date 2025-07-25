# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important Rules

- **NEVER modify shadcn/ui components**: Do not edit, update, or modify any files in `desktop/src/components/ui/`. These are third-party components that should remain untouched. Components in this folder should only be installed using `pnpm dlx shadcn@latest add <component-name>`. If UI changes are needed, create custom components or extend them in other directories.
- **Always use pnpm**: This project uses pnpm v10.13.1 as the package manager. Never use npm or yarn.
- **API Changes**: After modifying any API endpoints in Rust, you MUST regenerate the OpenAPI schema and TypeScript client by running both `cd desktop/src-tauri && cargo run --bin dump_openapi` and `pnpm codegen`.

## Common Development Commands

### Building and Running

```bash
# Install dependencies (uses pnpm)
pnpm install

# Run the full application in development mode
pnpm tauri dev

# Build the desktop application  
pnpm tauri build

# Run only the frontend (Vite dev server on port 1420)
pnpm dev

# Preview production build
pnpm preview
```

### Testing

```bash
# Frontend tests (Vitest in watch mode)
pnpm test

# Run a single test file
pnpm test path/to/test.tsx

# Run frontend tests once (CI mode)
pnpm test run

# Rust tests (run from desktop/src-tauri)
cd desktop/src-tauri && cargo test

# Run a single Rust test
cd desktop/src-tauri && cargo test test_name

# Run Rust tests with output
cd desktop/src-tauri && cargo test -- --nocapture
```

### Code Quality

```bash
# Format TypeScript/React code with Prettier
pnpm prettier

# Check TypeScript/React formatting
pnpm prettier --check .

# TypeScript type checking
pnpm typecheck

# Format Rust code
cd desktop/src-tauri && cargo fmt

# Check Rust formatting
cd desktop/src-tauri && cargo fmt --check

# Run Rust linter
cd desktop/src-tauri && cargo clippy --all-targets --all-features -- -D warnings
```

### OpenAPI Schema Management

```bash
# Generate OpenAPI schema from Rust code
cd desktop/src-tauri && cargo run --bin dump_openapi

# Generate TypeScript client from OpenAPI schema
pnpm codegen

# Both commands MUST be run after modifying API endpoints
```

### Database Inspection

```bash
# Launch sqlite-web to inspect the database in browser
pnpm dbstudio

# The script will:
# - Automatically find the database location (~/Library/Application Support/com.archestra-ai.app/archestra.db on macOS)
# - Install sqlite-web via uv if not available (falls back to pip)
# - Open the database at http://localhost:8080
# - Allow browsing tables, running queries, and viewing schema
```

### OAuth Proxy Service

```bash
cd backend/oauth-proxy
npm install
npm run dev  # Development mode with nodemon
npm start    # Production mode
```

## High-Level Architecture

This is a **Tauri desktop application** that integrates AI/LLM capabilities with MCP (Model Context Protocol) support for a privacy-focused AI assistant with extensible tool support.

### Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + TailwindCSS v4 + shadcn/ui components
- **State Management**: Zustand v5
- **Routing**: Tanstack React Router
- **Backend**: Rust with Tauri v2 framework, Axum web framework, SeaORM for SQLite database
- **API Layer**: HTTP gateway on port 54587 with OpenAPI schema generation using utoipa
- **Services**: Node.js OAuth proxy for handling OAuth flows
- **AI Integration**: Ollama for local LLM support, MCP (Model Context Protocol) for tool integration
- **Testing**: Vitest + React Testing Library (frontend), Rust built-in test framework with rstest (backend)

### Key Directories

#### Frontend (`desktop/src/`)

- `components/`: Reusable UI components
  - `ui/`: Base UI components (shadcn/ui style) - DO NOT MODIFY
    - `popover.tsx`: Added for UI interactions (installed via shadcn)
  - `kibo/`: AI-specific components (messages, code blocks, reasoning)
  - `DeleteChatConfirmation.tsx`: Dialog for chat deletion confirmation
  - `TypewriterText.tsx`: Animated text display component
- `pages/`: Main application pages
  - `ChatPage/`: AI chat interface with streaming responses
  - `ConnectorCatalogPage/`: MCP server catalog and management
  - `LLMProvidersPage/`: LLM model management
  - `SettingsPage/`: Application settings
- `stores/`: Zustand stores for state management
  - `chat-store.ts`: Chat state management with persistence integration
- `hooks/`: Custom React hooks including MCP client hooks
  - `use-typewriter.ts`: Hook for typewriter text animation
- `lib/`: Utility functions and helpers
  - `api/`: Generated TypeScript client from OpenAPI schema (DO NOT EDIT)
  - `api-client.ts`: Configured HTTP client instance

#### Backend (`desktop/src-tauri/`)

- `src/database/`: Database layer with SeaORM entities and migrations
- `src/models/`: Business logic and data models
  - `chat/`: Chat management with CRUD operations and title generation
  - `message/`: Message persistence and chat history management
  - `mcp_server/`: MCP server models including OAuth support
  - `external_mcp_client/`: External MCP client configurations
  - `mcp_request_log/`: Request logging and analytics
- `src/gateway/`: HTTP gateway exposing the following APIs:
  - `/api`: REST API for Archestra resources (OpenAPI documented)
    - `/api/chat`: Chat CRUD operations (create, read, update, delete chats)
  - `/mcp`: Archestra MCP server endpoints
  - `/proxy/:mcp_server`: Proxies requests to MCP servers running in Archestra sandbox
  - `/llm/:provider`: Proxies requests to LLM providers
- `src/ollama.rs`: Ollama integration for local LLM and chat title generation
- `src/openapi.rs`: OpenAPI schema configuration using utoipa
- `binaries/`: Embedded Ollama binaries for different platforms
- `sandbox-exec-profiles/`: macOS sandbox profiles for security

### Core Features

1. **MCP Integration**: Supports MCP servers for extending AI capabilities with tools via rmcp library
2. **Local LLM Support**: Runs Ollama locally for privacy-focused AI interactions
3. **Chat Persistence**: Full CRUD operations for chat conversations with SQLite database storage
4. **Intelligent Chat Titles**: Automatic LLM-generated chat titles based on conversation content
5. **OAuth Authentication**: Handles OAuth flows for services like Gmail
6. **Chat Interface**: Full-featured chat UI with streaming responses and tool execution
7. **Security**: Uses macOS sandbox profiles for MCP server execution
8. **API Documentation**: Auto-generated OpenAPI schema with TypeScript client

### Database Schema

The application uses SQLite with SeaORM for database management. Key tables include:

#### Chat Management Tables

- **chats**: Stores chat sessions with metadata
  - `id` (Primary Key): Auto-incrementing chat identifier
  - `title`: Chat title (auto-generated or user-defined)
  - `llm_provider`: LLM provider used (e.g., "ollama")
  - `llm_model`: Specific model name (e.g., "llama3.2")
  - `created_at`, `updated_at`: Timestamps

- **messages**: Stores individual messages within chats
  - `id` (Primary Key): Auto-incrementing message identifier
  - `chat_id` (Foreign Key): References chats.id with CASCADE delete
  - `role`: Message role ("user", "assistant", "system")
  - `content`: Message content as text
  - `created_at`: Timestamp

The relationship ensures that deleting a chat automatically removes all associated messages.

### Key Patterns

#### API Endpoint Pattern (Rust)
```rust
#[utoipa::path(
    get,
    path = "/api/resource",
    tag = "resource",
    responses(
        (status = 200, description = "Success", body = Vec<Resource>),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn get_resources(
    State(service): State<Arc<Service>>,
) -> Result<Json<Vec<Resource>>, StatusCode> {
    // Implementation
}
```

#### Frontend API Calls
```typescript
import { apiClient } from "@/lib/api-client";

// Always use the generated API client
const response = await apiClient.getResources();
if (response.data) {
  // Handle success
}
```

#### Zustand Store Pattern
```typescript
interface StoreState {
  items: Item[];
  isLoading: boolean;
  fetchItems: () => Promise<void>;
}

export const useItemStore = create<StoreState>((set) => ({
  items: [],
  isLoading: false,
  fetchItems: async () => {
    set({ isLoading: true });
    try {
      const response = await apiClient.getItems();
      set({ items: response.data || [] });
    } finally {
      set({ isLoading: false });
    }
  },
}));
```

#### Chat API Endpoints

The application provides RESTful endpoints for chat management:

```typescript
// Get all chats (ordered by updated_at DESC)
GET /api/chat
Response: Chat[]

// Get specific chat with messages
GET /api/chat/{id}  
Response: ChatWithMessages

// Create new chat
POST /api/chat
Body: { llm_provider: string, llm_model: string }
Response: Chat (with auto-generated title "New Chat")

// Delete chat and all messages (CASCADE deletes all messages)
DELETE /api/chat/{id}
Response: 204 No Content
```

**Chat Persistence Workflow**:
1. When a user sends their first message, the frontend automatically creates a new chat if none exists
2. During conversation streaming through the Ollama proxy (`/llm/ollama/api/chat`), messages are automatically saved to the database
3. User messages are saved before sending to the LLM
4. Assistant responses are captured and saved after streaming completes

**Chat Title Generation**: 
- Triggers automatically after the 4th message in a chat (2 user + 2 assistant messages)
- Uses the same LLM model as the chat to generate a concise 5-6 word title
- Runs asynchronously in the background without blocking the conversation
- Emits a `chat-title-updated` event that the frontend listens to for real-time UI updates

### Important Configuration

- **Package Manager**: pnpm v10.13.1 (NEVER use npm or yarn)
- **Node Version**: 24.4.1
- **Gateway Port**: 54587 (configured in `desktop/src/consts.ts`)
- **TypeScript Path Alias**: `@/` maps to `./src/`
- **Prettier Config**: 120 character line width, single quotes, sorted imports
- **Pre-commit Hooks**: Prettier formatting via Husky
- **OpenAPI Generation**: Clean output directory, Prettier formatting

### Key Dependencies Added for Chat Persistence

- **Frontend**: 
  - `@radix-ui/react-popover`: For popover UI component (required by shadcn/ui)
- **Backend**:
  - `tokio`: Enhanced with async runtime features for spawning background tasks

### CI/CD Workflow

The GitHub Actions CI/CD pipeline consists of several workflows with concurrency controls to optimize resource usage:

#### Main Testing Workflow (`.github/workflows/linting-and-tests.yml`)
- PR title linting with conventional commits
- Rust formatting and linting checks
- Rust tests on Ubuntu, macOS (ARM64 & x86_64), and Windows
- Frontend formatting and tests
- Frontend build verification
- OpenAPI schema freshness check (ensures schema and TypeScript client are up-to-date)
- Zizmor security analysis for GitHub Actions

#### Pull Request Workflow (`.github/workflows/on-pull-requests.yml`)
- Runs the main testing workflow on all PRs
- **Automated Claude Code Reviews**: Uses Claude Opus 4 model to provide automated PR reviews with feedback on code quality, security, and best practices
- **Automated CLAUDE.md Updates**: Uses Claude Sonnet 4 model to automatically:
  - Update the CLAUDE.md file to reflect changes made in PRs
  - Add PR descriptions when they are missing
  - Ensure documentation stays current with codebase changes
- Both Claude jobs skip release-please PRs; the review job also skips WIP PRs
- Concurrency control cancels in-progress runs when new commits are pushed
- Consolidates functionality from the removed `claude-code-review.yml` workflow

#### Release Please Workflow (`.github/workflows/release-please.yml`)
- Manages automated releases using Google's release-please action
- Creates and maintains release PRs with changelogs
- **Multi-platform desktop builds**: When a desktop release is created:
  - Builds Tauri desktop applications for Linux (ubuntu-latest) and Windows (windows-latest)
  - Uses matrix strategy with `fail-fast: false` to ensure all platforms build
  - Creates draft GitHub releases with platform-specific binaries
  - Tags releases with format `app-v__VERSION__`

#### Interactive Claude Workflow (`.github/workflows/claude.yml`)
- Triggers on `@claude` mentions in issues, PR comments, and reviews  
- Provides comprehensive development environment with Rust and frontend tooling
- Supports extensive bash commands including testing, building, formatting, code generation, and package management
- Uses Claude Opus 4 model for complex development tasks
- Concurrency control prevents multiple Claude runs on the same issue/PR
- Pre-configured with allowed tools for pnpm, cargo, and project-specific commands

### Development Notes

- Single instance enforcement prevents multiple app instances
- The app supports deep linking with `archestra-ai://` protocol
- MCP servers are sandboxed for security on macOS
- OAuth proxy runs as a separate service on a configured port
- OpenAPI schema must be regenerated after API changes (CI will catch if forgotten)
- Frontend API calls should use the generated client, not Tauri commands
- Database migrations should be created for schema changes using SeaORM
- **Chat Persistence**: All chat conversations are automatically saved to SQLite database
  - The Ollama proxy (`/llm/ollama/api/chat`) transparently intercepts and saves messages:
    - User messages are parsed from the request and saved before forwarding to Ollama
    - Assistant responses are captured from the streaming chunks and saved after completion
  - Messages are saved asynchronously using spawned tasks to avoid blocking the stream
  - Chat creation is automatic when the first message is sent (using the most recent chat or creating new)
  - The `create_or_get_chat` function manages chat lifecycle seamlessly
- **Chat Title Generation**: 
  - Triggers automatically after the 4th message in a chat (2 user + 2 assistant messages)
  - Uses a background task (`generate_chat_title`) to avoid blocking the conversation flow
  - Generates titles using the same LLM model as the chat for consistency
  - Title generation prompt asks for a "brief 5-6 word title that captures the main topic"
  - Uses a 30-second timeout for title generation to prevent hanging
- **Event-Driven Updates**: 
  - Backend emits Tauri events for real-time UI updates:
    - `chat-title-updated` event with `{chatId, title}` payload
  - Frontend chat store subscribes to these events in `initializeStore()`
  - Events enable instant UI updates without polling
- **Database Relationships**: 
  - Messages have CASCADE delete foreign key constraint with chats
  - Deleting a chat automatically removes all associated messages
  - Ensures data consistency and prevents orphaned messages
- **Message Streaming Architecture**:
  - Ollama proxy uses `tokio::sync::mpsc` channels to collect streaming chunks
  - Chunks are forwarded to the client while being accumulated for storage
  - Assistant content is extracted from either streaming JSON lines or single response format
  - The `extract_assistant_content` function handles both Ollama response formats
- **Testing Patterns**:
  - Use rstest fixtures from `test_fixtures` for Rust database tests
  - The chat API includes comprehensive integration tests covering CRUD operations
  - Message persistence tests verify ordering and cascade deletion
  - Mock Ollama responses return BAD_GATEWAY in tests since server isn't running
