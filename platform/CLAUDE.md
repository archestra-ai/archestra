# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Directory

**ALWAYS run all commands from the `platform/` directory unless specifically instructed otherwise.**

## Important Rules

1. **ALWAYS use pnpm** (not npm or yarn) for package management
2. **Use Biome for formatting and linting** - Run `pnpm lint` before committing changes
3. **TypeScript strict mode** - Ensure code passes `pnpm type-check` before completion
4. **Tilt for development** - The project uses Tilt to orchestrate the development environment

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
pnpm cli-chat-with-guardrails  # Test guardrails CLI
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
- **Frontend**: Next.js 15.5.4 with React 19 + Turbopack + Tailwind CSS 4
- **Database**: PostgreSQL with Drizzle ORM for chat/interaction persistence
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
│       ├── types.ts             # TypeScript type definitions
│       ├── database/            # Database layer
│       │   ├── migrations/      # Drizzle migrations
│       │   └── schema.ts        # Database schema
│       ├── guardrails/          # Security guardrails (production-ready)
│       │   ├── dual-llm.ts      # Dual LLM pattern for prompt injection detection
│       │   ├── tool-invocation.ts  # Tool invocation policy enforcement
│       │   └── trusted-data.ts     # Taint analysis and trusted data marking
│       ├── models/              # Data models
│       │   ├── agent.ts         # Agent model with CRUD operations
│       │   ├── chat.ts          # Chat model
│       │   ├── interaction.ts   # Interaction model
│       │   ├── tool-invocation-policy.ts  # Tool invocation policy model
│       │   └── trusted-data-policy.ts     # Trusted data policy model
│       ├── providers/           # LLM provider abstraction
│       │   ├── factory.ts       # Provider factory pattern
│       │   ├── openai.ts        # OpenAI provider implementation
│       │   └── types.ts         # Provider interfaces
│       └── routes/              # API routes
│           ├── agent.ts         # Agent management endpoints
│           ├── autonomy-policies.ts  # Autonomy policies endpoints
│           ├── chat.ts          # Chat and LLM endpoints
│           └── proxy/           # OpenAI proxy with integrated guardrails
│               ├── openai.ts    # Main proxy route handler
│               ├── types.ts     # TypeScript types for proxy
│               └── utils/       # Proxy utilities (modular structure)
│                   ├── index.ts              # Core agent/chat management, message persistence
│                   ├── streaming.ts          # SSE streaming handler for chat completions
│                   ├── tool-invocation.ts    # Tool invocation policy evaluation
│                   └── trusted-data.ts       # Trusted data policy evaluation and taint tracking
├── frontend/          # Next.js web application
│   └── src/
│       └── app/       # Next.js App Router pages
├── experiments/       # Experimental features and prototypes
│   └── src/
│       ├── main.ts              # OpenAI proxy server (port 9000)
│       ├── interceptor.ts       # Request interception logic
│       ├── logger.ts            # Logging utilities
│       └── cli-chat.ts          # CLI chat interface for testing
└── shared/            # Shared utilities (currently empty)
```

### Development Orchestration

The project uses **Tilt** to orchestrate the development environment:

1. **Pre-requisites**: Runs `pnpm install` before starting services
2. **Dev Services**: Starts `pnpm dev` (via Turbo) to run all workspaces
3. **Linting**: Runs `pnpm type-check && pnpm lint` continuously

Tilt automatically manages dependencies and ensures services start in the correct order.

### Backend API

The production backend provides:

#### REST API Endpoints

- **Chat Management**:
  - `POST /api/chats` - Create new chat session
  - `GET /api/chats/:chatId` - Get chat with all interactions
  - **Note**: Chat ID is now optional when using the OpenAI proxy - if not provided via `x-archestra-chat-id` header, a chat will be created/retrieved based on the hash of the first message
- **LLM Integration**:
  - `POST /v1/:provider/chat/completions` - OpenAI-compatible chat endpoint
    - Optional `x-archestra-chat-id` header - if not provided, automatically creates/retrieves default agent and chat based on message content hash
  - `GET /v1/:provider/models` - List available models for a provider
  - Supports streaming responses for real-time AI interactions
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
  - `GET /api/tools` - List all tools with trust settings
  - `PATCH /api/tools/:id` - Update tool configuration including trust policies

#### Security Features (Production-Ready)

The backend integrates advanced security guardrails:

- **Dual LLM Pattern**: Quarantined + privileged LLMs for prompt injection detection
- **Tool Invocation Policies**: Fine-grained control over tool usage
  - Control when tools can be invoked based on argument values
  - Support for multiple operators (equal, notEqual, contains, startsWith, endsWith, regex)
  - Actions: allow_when_context_is_untrusted or block_always with custom reason text
  - Tools can be configured with:
    - `allow_usage_when_untrusted_data_is_present`: Allow tool to run with untrusted data
    - `data_is_trusted_by_default`: Mark tool outputs as trusted by default
- **Trusted Data Policies**: Mark specific data patterns as trusted or blocked
  - Uses attribute paths to identify data fields
  - Same operator support as invocation policies
  - Actions:
    - `allow`: Mark data as trusted
    - `block_always`: Prevent data from reaching LLM (blocked data is filtered out before sending to the model)
- **Taint Analysis**: Tracks untrusted data through the system
- **Database Persistence**: All chats and interactions stored in PostgreSQL

#### Database Schema

- **Agent**: Stores AI agents with name and timestamps
- **Chat**: Stores chat sessions with timestamps and agent reference
- **Interaction**: Stores messages with trust status, blocked flag, and reasoning
  - `trusted`: Boolean indicating if data is trusted (inverse of old "tainted" field)
  - `blocked`: Boolean indicating if data was blocked by policies
  - `reason`: Text explaining trust/block decision (renamed from "taint_reason")
- **Tool**: Stores available tools with metadata and trust configuration
- **ToolInvocationPolicy**: Policies for controlling tool usage
  - Links to tools and agents
  - Stores argument path, operator, value, action, and reason
- **TrustedDataPolicy**: Policies for marking data as trusted or blocked
  - Stores attribute path, operator, value, and action ("mark_as_trusted" or "block_always")
- **AgentToolInvocationPolicy**: Junction table linking agents to their policies
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
  - Supports `--agent-id <agent-id>` flag to specify an agent (optional)
  - If no agent ID is provided, the backend will create/use a default agent
  - Additional flags: `--include-external-email`, `--include-malicious-email`, `--debug`
- Requires `OPENAI_API_KEY` in `.env` (copy from `.env.example`)

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

### Development Best Practices

- Use existing patterns and libraries - check neighboring files for examples
- Follow existing naming conventions (camelCase for TypeScript)
- Test files should be colocated with source (`.test.ts` extension)
- Use workspace-relative imports within each workspace
- Run `pnpm type-check` before committing to catch type errors
- Use `tilt up` for the best development experience with hot reload

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

#### Release Workflow Details

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
