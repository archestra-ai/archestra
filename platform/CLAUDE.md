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

- **Frontend**: http://localhost:3000/
- **Tools Inspector**: http://localhost:3000/tools
- **Dual LLM Config**: http://localhost:3000/dual-llm
- **Tilt UI**: http://localhost:10350/
- **Drizzle Studio**: https://local.drizzle.studio/
- **MCP Gateway**: http://localhost:9000/mcp/{agentId}

## Common Commands

```bash
# Development
tilt up              # Start full development environment
pnpm dev             # Start all workspaces
pnpm lint            # Lint and auto-fix
pnpm type-check      # Check TypeScript types
pnpm test            # Run tests

# Database
pnpm db:migrate      # Run database migrations
pnpm db:studio       # Open Drizzle Studio
```

## Environment Variables

```bash
# Required
DATABASE_URL="postgresql://archestra:archestra_dev_password@localhost:5432/archestra_dev?schema=public"

# Provider API Keys
OPENAI_API_KEY=your-api-key-here
GEMINI_API_KEY=your-api-key-here
ANTHROPIC_API_KEY=your-api-key-here
```

## Architecture

**Tech Stack**: pnpm monorepo, Fastify backend (port 9000), Next.js frontend (port 3000), PostgreSQL + Drizzle ORM, Biome linting, Tilt orchestration

**Key Features**: MCP tool execution, dual LLM security pattern, tool invocation policies, trusted data policies

**Workspaces**:
- `backend/` - Fastify API server with security guardrails
- `frontend/` - Next.js app with tool management UI
- `experiments/` - CLI testing and proxy prototypes
- `shared/` - Common utilities and types

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
- Only export public APIs

**Testing**: Vitest with PGLite for in-memory PostgreSQL testing
