# Product spec: copy the suggested URL from error toasts

## Problem

When "Test & Create" for a self-hosted LLM provider (e.g. Ollama) fails to connect, the backend appends a hint to the error message: `If this server is running in Docker, "localhost" points at the container itself, not your host machine — try using http://host.docker.internal:11434/v1 instead.` The toast shows this full URL, but the user has to retype it by hand into the Base URL field — there is no way to copy it. Toasts have no copy affordance anywhere in the app.

## Current state (verified 2026-07-16)

- All API error toasts flow through one chokepoint: `handleApiError` calls `toast.error(sentryError.message, { duration: 12000 })` — `platform/frontend/src/lib/utils/api.ts:88`. The toast renders sonner's default layout; the Toaster config lives in `platform/frontend/src/components/ui/sonner.tsx`.
- The hint is composed on the backend by `dockerLocalhostConnectionHint` (`platform/backend/src/utils/docker-localhost-hint.ts:26-50`) and appended by the Test & Create endpoints at `platform/backend/src/routes/llm-provider-api-keys.ts:65,93`. The frontend receives one opaque message string.
- The docker hint is the only backend error message today that embeds a full URL; other dynamic error messages carry only names or IDs.
- No toast in the codebase uses sonner's `action:` option. Sonner v2 (`sonner@^2.0.7`, `platform/frontend/package.json`) natively supports `action: { label, onClick }`, rendered as a small button inside the toast; clicking it dismisses the toast by default.

## Proposed change

Frontend-only, one file: `platform/frontend/src/lib/utils/api.ts`, in `handleApiError`.

Extract the first URL from the error message and, when present, attach a copy action:

```ts
const url = sentryError.message.match(/https?:\/\/[^\s"')]+/)?.[0];
toast.error(sentryError.message, {
  duration: 12000,
  ...(url && {
    action: {
      label: "Copy URL",
      onClick: () => void navigator.clipboard.writeText(url),
    },
  }),
});
```

- The button copies just the URL (not the surrounding prose) and dismisses the toast — the dismissal doubles as copy feedback.
- Messages without a URL render exactly as today.
- Because the change sits at the global chokepoint, any future backend hint that embeds a URL gets the affordance automatically.

Explicitly out of scope: backend changes (structured hint field), a custom toast component, and a generic "copy whole message" button.

## Verification

Using the local Ollama setup from [ollama-repro-runbook.md](./ollama-repro-runbook.md) (or no Ollama at all — a connection failure is the point):

1. Open <http://localhost:3000/llm/model-providers>, add an Ollama provider with base URL `http://localhost:11434/v1` while nothing listens on that port, and click Test & Create.
2. The error toast (bottom-right) shows the docker hint plus a "Copy URL" button; clicking it puts `http://host.docker.internal:11434/v1` on the clipboard and dismisses the toast.
3. Trigger a URL-less API error (any validation failure) — the toast renders without the button.
4. `pnpm lint && pnpm type-check` in `platform/`.
