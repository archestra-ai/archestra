# Connect prototype playground

`/connection-prototype` is a sandbox for comparing rough Connect page ideas
side by side inside the real app shell. It is not a product page.

- **On** in development builds. **Off** (404) in production builds unless the
  deployment sets `ARCHESTRA_FRONTEND_CONNECT_PROTOTYPES_ENABLED=true`.
- Not linked from navigation and not referenced by `/connection`.

## Using it

- Pick a variant from the toolbar, or flip with `[` and `]`.
- Pick a mock scenario (first visit, returning user, empty gateway, at scale)
  and a persona (end user or admin).
- The URL carries `variant`, `scenario` and `persona`, so a link reproduces
  exactly what you were looking at.

## Adding a variant

1. Copy `variants/starter.tsx` to `variants/<id>.tsx`.
2. Add one entry to `PROTOTYPE_VARIANTS` in `variants.ts` with an `id`, a
   `title`, a one-line `hypothesis`, and `data: "mock"`.
3. Render from the `scenario` and `persona` props. If a variant needs data the
   mocks lack, add the field to `_parts/scenarios.ts`.

Rules of thumb:

- Prefer mock data. Prototypes should not depend on backend changes before a
  direction is picked. Use `data: "live"` only when the point of the variant
  is real data (the `today` baseline does this).
- Keep a variant to its own file or folder under `variants/` so deleting a
  rejected idea is one `rm` plus one registry line.
- Do not import prototype code from production routes. When a direction wins,
  rebuild it properly under `app/connection/`.
