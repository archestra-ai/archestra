# Cursor Project Rules

This directory contains modern Cursor Project Rules following [Cursor's best practices](https://docs.cursor.com/en/context/rules).

## Structure

Rules are organized into focused, composable files:

### Always-Applied Rules

These rules apply globally to the entire project:

- **`project-conventions.mdc`** - Core conventions, working directory, package management, code quality
- **`tech-stack.mdc`** - Technology stack, architecture patterns, and framework guidelines  
- **`development-workflow.mdc`** - Development commands, workflows, and debugging resources

### Context-Specific Rules

These rules apply only when working with matching files (via `globs`):

- **`backend-models.mdc`** - Guidelines for backend model files and database operations
  - Applies to: `backend/src/models/**/*.ts`
  - Key practices: CRUD patterns, Drizzle ORM, testing, flat structure, no barrel files
- **`frontend-components.mdc`** - React components and Next.js App Router patterns
  - Applies to: `frontend/src/components/**/*.tsx`, `frontend/src/app/**/*.tsx`, `frontend/src/lib/**/*.ts`
  - Key practices: Small components, TanStack Query, Suspense, error boundaries, theme colors, no barrel files
- **`shared-workspace.mdc`** - Guidelines for shared code used by both frontend and backend
  - Applies to: `shared/**/*.ts`
  - Key practices: Environment-agnostic code, shared types, validation schemas, constants

## Best Practices

Following Cursor's recommended practices:

✅ **Keep rules concise** - Each rule is focused and under 500 lines  
✅ **Split large rules** - Rules are divided into composable, topic-specific files  
✅ **Provide concrete examples** - Each rule includes code examples  
✅ **Use clear metadata** - Each rule has description, globs, and alwaysApply settings  
✅ **Scope appropriately** - Context-specific rules use globs to apply only when relevant  

## Adding New Rules

When adding new rules:

1. Create a new `.mdc` file in this directory
2. Add frontmatter with metadata:
   ```yaml
   ---
   description: Brief description of the rule's purpose
   globs: 
     - path/to/files/**/*.ts  # Optional: only for context-specific rules
   alwaysApply: true|false     # true for global, false for context-specific
   ---
   ```
3. Write clear, actionable guidance with examples
4. Keep rules focused on a single concern
5. Update this README if adding a major new rule category

## Syncing with CLAUDE.md

**⚠️ IMPORTANT**: Keep these rules synchronized with `CLAUDE.md` for Claude Code users. When updating rules here, update the corresponding sections in `CLAUDE.md`.

