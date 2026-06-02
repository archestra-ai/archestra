---
name: archestra-dev-frontend
description: Use when modifying Archestra frontend Next.js/React code, UI components, forms, TanStack Query hooks, generated API client usage, frontend copy, or documentation links.
---

# Archestra Frontend Development

Use this skill before changing files under `platform/frontend/` or frontend-facing shared code.

## Commands

Run commands from `platform/` unless specifically instructed otherwise.

```bash
pnpm codegen:api-client
pnpm type-check
pnpm lint
pnpm test
```

## Data fetching

- Use TanStack Query for data fetching.
- Prefer `useQuery` over `useSuspenseQuery` with explicit loading states.
- Prefer TanStack Query over prop drilling when a component can fetch data by identifier itself.
- Only pass minimal identifiers, such as `catalogId`, needed for child components to fetch or filter their own data.
- TanStack Query caching prevents duplicate requests when multiple components use the same query.

## API clients

- Frontend `.query.ts` files should never use `fetch()` directly.
- Run `pnpm codegen:api-client` first to ensure the generated SDK is up to date.
- Use generated SDK methods instead of manual API calls for type safety and consistency.
- Reuse API types from `@shared`, especially `archestraApiTypes` types such as `archestraApiTypes.CreateXxxData["body"]` and `archestraApiTypes.GetXxxResponses["200"]`.
- Do not define duplicate frontend API types when generated/shared types already exist.

## Query error handling

- Handle toasts in `.query.ts` files, not in components.
- Define mutation success/error toasts in `onSuccess` and `onError` callbacks.
- Never throw on HTTP errors in query or mutation functions.
- Use `handleApiError(error)` for user notification and return an appropriate default such as `null`, `[]`, or `{}`.
- Components should not use `try`/`catch` for API calls; API error handling belongs in `.query.ts` files.

## UI components

- Use shadcn/ui components only.
- Add shadcn/ui components with `npx shadcn@latest add <component>`.
- Prefer components from `frontend/src/components/ui` over plain HTML elements when a component exists.
- Use `Button` over raw `<button>`, `Input` over raw `<input>`, and the matching UI component for selects and other controls.
- Keep components small and focused, with extracted business logic where it improves clarity.
- Keep frontend files flat where practical and avoid barrel files.
- Only export what is needed externally.

## Forms

- Prefer `useForm` from `react-hook-form` over multiple `useState` hooks for form state.
- Pass form objects to child components as `form: UseFormReturn<FormValues>` rather than passing individual setters.
- Parent components should handle mutations and submission.
- Form components should focus on rendering and validation UI.

## Copy and documentation links

- Do not hardcode `Archestra` in frontend UI copy.
- Use `const appName = useAppName();` and interpolate the app name so white-labeled deployments render correctly.
- Always use `getDocsUrl(DocsPage.PageName, "optional-anchor")` from `@shared` for documentation links.
- Never hardcode documentation URLs.
