<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Conventions

Load the `archestra-dev-frontend` skill (`.agents/skills/archestra-dev-frontend/SKILL.md`) before editing files here.

| What | Convention |
| --- | --- |
| Route-private folder | `_parts/` under the route, for the components, hooks, utils and types that belong to that route only. Not `_components/`, the example the Next.js docs use: these folders hold more than components, and `_parts/` is the name the app was scaffolded with. |
| Client page | A server `page.tsx` that renders a `page.client.tsx` beside it. |
| Hook | `use-<thing>.ts`, named after the exported hook, beside the feature that uses it. `lib/hooks/` is for hooks shared across features; promote a hook there when a second feature imports it. |
| File name | kebab-case, ASCII. |
| Dot suffixes | Closed list: `.query`, `.keys`, `.utils`, `.types`, `.constants`, `.context`, `.server`, `.client`, `.ee`, `.test`, `.test-data`. A test may add topic segments before `.test` (`page.client.streaming.test.tsx`). Anything else folds into the kebab name. |

Biome enforces these (`useFilenamingConvention` and the `route-private-folder` and `hook-file-name` plugins in `platform/biome.json`). To check changed files, run `pnpm biome check --changed --since=origin/main` from `platform/`, substituting the fetched target branch for `origin/main` when the PR targets a different branch.
