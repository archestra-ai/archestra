# Site Notification And Maintenance Design

**Issue:** `archestra-ai/archestra#4463`

## Goal

Add an organization-configurable site notification banner and an environment-driven maintenance mode without leaking notification content to users who do not have permission to read it.

## Chosen Approach

Use a dedicated notification API surface with its own RBAC resource instead of piggybacking on the existing organization payload. This keeps read access real rather than cosmetic. Keep persistence small by storing notification fields on the organization record, but only expose them through dedicated backend routes and types.

Maintenance mode stays environment-driven. The backend exposes the public maintenance message through config routes, and the frontend replaces the normal app experience with a maintenance screen when the flag is active.

## Backend Design

- Add `siteNotification` as a first-class RBAC resource in `shared`.
- Add dedicated routes for:
  - reading the active site notification
  - updating notification content and expiration
- Store notification fields on the organization model, but do not include them in generic organization API responses.
- Parse maintenance env vars in `backend/src/config.ts`.
- Expose maintenance state through `/api/config/public` so the frontend can decide whether to render the app shell or the maintenance screen.
- Add maintenance middleware that blocks most application routes while allowing health, auth, public config, and other bootstrap routes needed to load the maintenance page.

## Frontend Design

- Render the notification banner in the main content area of the app shell, below the impersonation banner and above page content.
- Add an organization settings section for admins to edit:
  - markdown message
  - optional expiration timestamp
- Show a preview using the existing markdown rendering approach.
- Replace the normal authenticated app surface with a maintenance screen when maintenance mode is enabled.

## Testing

- Backend config parsing tests for maintenance env vars.
- Backend route tests for notification read/update permissions and expiration behavior.
- Frontend tests for maintenance gating and notification rendering.

## Constraints

- No new database table unless the existing organization record proves too awkward.
- No commit or push without explicit user approval.
