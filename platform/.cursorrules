# Cursor Rules for Archestra Platform

**⚠️ DEPRECATED: This file is legacy. Modern Cursor uses Project Rules in `.cursor/rules/`.**
**For the latest rules, see `.cursor/rules/` directory.**

**⚠️ IMPORTANT: Keep `.cursor/rules/` in sync with CLAUDE.md. When updating one, update the other.**

## Working Directory

**ALWAYS run all commands from the `platform/` directory unless specifically instructed otherwise.**

## Important Rules

1. **ALWAYS use pnpm** (not npm or yarn) for package management
2. **Use Biome for formatting and linting** - Run `pnpm lint` before committing changes
3. **TypeScript strict mode** - Ensure code passes `pnpm type-check` before completion
4. **Tilt for development** - The project uses Tilt to orchestrate the development environment
5. **Use shadcn/ui components** - Add components with `npx shadcn@latest add <component>` instead of using Radix UI directly

## Tech Stack

- **Monorepo**: pnpm workspaces with Turbo for build orchestration
- **Development**: Tilt for local development orchestration
- **Backend**: Fastify + Drizzle ORM (PostgreSQL)
- **Frontend**: Next.js 15.5.4 + React 19 + Turbopack + Tailwind CSS 4 + shadcn/ui
- **Code Quality**: Biome for linting and formatting
- **Testing**: Vitest with PGLite

## Development Best Practices

- Use existing patterns and libraries - check neighboring files for examples
- Follow existing naming conventions (camelCase for TypeScript)
- Test files should be colocated with source (`.test.ts` extension)
- Use workspace-relative imports within each workspace
- Run `pnpm type-check` before committing to catch type errors
- Use `tilt up` for the best development experience with hot reload

## Function Parameters

- **If a function accepts more than 2 parameters**, use a single object parameter instead of multiple positional parameters
- This improves readability, makes parameters self-documenting, and allows for easier future extension
