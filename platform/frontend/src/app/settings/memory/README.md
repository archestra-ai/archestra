# Settings Memory UI

This module implements the `/settings/memory` experience for durable memory operations.

## Responsibilities

- render paginated memory list with status tabs, scope filtering, and content search;
- expose role-aware review actions (approve/reject/archive/restore/delete);
- provide manual memory proposal flow;
- show memory metadata and policy details in a side drawer.

## Main Files

- `page.tsx`: settings route entry with `ErrorBoundary`.
- `_parts/memory-list.tsx`: table, filters, banners, action wiring.
- `_parts/memory-create-dialog.tsx`: manual memory proposal form.
- `_parts/memory-approve-dialog.tsx`: approval workflow with optional edit.
- `_parts/memory-reject-dialog.tsx`: rejection workflow with reason enforcement.
- `_parts/memory-detail-drawer.tsx`: detailed metadata and history view.
- `_parts/memory-utils.ts`: labels and scope/role authorization helpers.
