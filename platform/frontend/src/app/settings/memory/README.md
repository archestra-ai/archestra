# Settings → Memory (Frontend)

Implements the `/settings/memory` experience for reviewing durable memory candidates, managing approved and archived records, and proposing memory manually. Backend pair lives at [`backend/src/memory`](../../../../../backend/src/memory); public documentation is in [`docs/pages/platform-memory.md`](../../../../../../docs/pages/platform-memory.md).

## Page composition

```
settings/memory/
├── page.tsx                        # Route entry, tabs: Records | Settings
└── _parts/
    ├── memory-list.tsx             # Table, status tabs, scope filter, search, banners
    ├── memory-settings.tsx         # Org-level extraction/injection/retention settings
    ├── memory-settings-utils.ts    # Initial form state + payload diff helpers
    ├── memory-create-dialog.tsx    # Manual candidate proposal form
    ├── memory-approve-dialog.tsx   # Approval with optional content edit
    ├── memory-reject-dialog.tsx    # Rejection with required reason
    ├── memory-detail-drawer.tsx    # Read-only metadata, policy flags, history
    └── memory-utils.ts             # Labels, scope-role authorization helpers
```

`page.tsx` owns top-level tabs: **Records** (`MemoryList`) and **Settings** (`MemorySettings`). `MemoryList` owns memory-status tab state (`pending`, `approved`, `archived`, `all`) and drives the dialogs and drawer. All rendering uses components from `frontend/src/components/ui` and app-name interpolation via `useAppName()`; there are no raw HTML form elements.

## Data layer

All queries and mutations are centralized in [`frontend/src/lib/memory.query.ts`](../../../../lib/memory.query.ts) and consumed via TanStack Query hooks. Never call `fetch` directly here; run `pnpm codegen:api-client` first and use the generated `archestraApiSdk` methods:

| Hook / mutation | SDK method | Purpose |
|---|---|---|
| `useListMemoryQuery` | `listMemory` | Paginated list with status, scope, search filters. |
| `useListPendingMemoryQuery` | `listPendingMemory` | Review queue for candidates. |
| `useMemoryQuery` | `getMemory` | Single-record detail for the drawer. |
| `useMemoryStatsQuery` | `getMemoryStats` | Counts for tab badges. |
| `useCreateMemoryMutation` | `createMemory` | Manual candidate creation. |
| `useUpdateMemoryMutation` | `updateMemory` | Candidate content edit (pre-approval only). |
| `useSupersedeMemoryMutation` | `supersedeMemory` | Append-only replacement of an approved record. |
| `useApproveMemoryMutation` | `approveMemory` | Promote candidate → approved. |
| `useRejectMemoryMutation` | `rejectMemory` | Decline with a taxonomy reason. |
| `useArchiveMemoryMutation` | `archiveMemory` / `unarchiveMemory` | Reversible hide. |
| `useDeleteMemoryMutation` | `deleteMemory` | Permanent delete; may emit a tombstone server-side. |
| `useUpdateMemorySettings` | `updateMemorySettings` | Update org-level memory runtime settings. |

All error handling and toasts are defined inside the mutation `onSuccess` / `onError` callbacks in `memory.query.ts`. Components never `try/catch` these calls and never surface toasts themselves. HTTP errors are routed through `handleApiError` and cause the mutation to resolve with sensible defaults rather than throwing.

## Role and scope visibility

Review actions are role- and scope-aware. `memory-utils.ts` centralizes the mapping between the caller's current permission set, the record's scope (`user`, `team`, `organization`), and the set of actions that should render as enabled, disabled, or hidden. A user with `memory:approve` still cannot approve a memory whose scope they do not belong to. The same helper drives the disabled state of individual rows and of the action menu in the detail drawer.

Permissions referenced:

- `memory:read`, `memory:create`, `memory:update`, `memory:approve`, `memory:delete`, `memory:team-admin`, `memory:admin` (custom RBAC resource).
- Predefined role fallbacks when the enterprise RBAC module is inactive.

Docs links rendered in the UI use `getDocsUrl(DocsPage.PlatformMemory, ...)` — never hardcoded URLs.

## Review queue behavior

The default tab is **Pending**, which shows candidates that have passed the pre-write screen but have not yet been resolved. Candidates arriving from the extractor, MCP `memory_propose`, or manual create are all routed to this queue.

- Candidates carrying high-risk policy flags (`instruction_like`, `instruction_like_high`, `instruction_like_medium`, `external_context`) render a prominent warning and **cannot** be approved through the normal approve action: the backend returns a deterministic policy error and the UI surfaces the reason instead of the approval confirmation.
- Rejecting a candidate requires a reason from the fixed taxonomy (`inaccurate`, `sensitive`, `manipulative`, `wrong_scope`, `temporary`, `duplicate`, `vague`, `not_useful`, `conflicts_with_existing`, `policy_violation`).
- The approve dialog allows a small content edit before promotion; edits are forwarded through `updateMemory` and then `approveMemory` in sequence.
- Supersede creates a new candidate linked by `supersedes_memory_id` — the underlying approved record is never mutated in place.

## Settings integration

The Memory tab is registered in [`settings-tabs.ts`](../settings-tabs.ts) and rendered by the shared settings layout ([`settings/layout.tsx`](../layout.tsx)). Visibility of the tab depends on the caller having at least `memory:read` in their effective role.

Within the page:

- **Records** tab uses memory routes (`/api/memory/*`) and existing `memory:*` permissions.
- **Settings** tab updates `/api/organization/memory-settings` and uses `WithPermissions` with `memorySettings:update`.
- Save flow uses a single `SettingsSaveBar` backed by `useUpdateMemorySettings`.

## Frontend ↔ backend contract map

| UI surface | Backend route | Policy gate |
|---|---|---|
| Pending queue | `GET /api/memory/pending` | `memory:read`, scope filter |
| List (all statuses) | `GET /api/memory` | `memory:read`, scope filter |
| Detail drawer | `GET /api/memory/:id` | `memory:read`, scope filter |
| Create candidate | `POST /api/memory` | `memory:create`, pre-write screen |
| Edit candidate | `PATCH /api/memory/:id` | `memory:update`, candidate-only |
| Supersede approved | `POST /api/memory/:id/supersede` | `memory:update`, pre-write screen |
| Approve | `POST /api/memory/:id/approve` | `memory:approve`, review-path guard |
| Reject | `POST /api/memory/:id/reject` | `memory:approve`, reason required |
| Archive / Unarchive | `POST /api/memory/:id/archive` / `.../unarchive` | `memory:update` |
| Delete | `DELETE /api/memory/:id` | `memory:delete`, may emit tombstone |
| Memory settings save | `PATCH /api/organization/memory-settings` | `memorySettings:update` |

## Testing

Component tests colocate with sources (`*.test.tsx`) and follow the project's behavior-focused style: assert rendering of headline states and action wiring, not incidental markup. See also backend integration tests in [`backend/src/routes/memory/routes.memory.test.ts`](../../../../../backend/src/routes/memory/routes.memory.test.ts) and [`backend/src/routes/chat/routes.memory-injection.test.ts`](../../../../../backend/src/routes/chat/routes.memory-injection.test.ts).
