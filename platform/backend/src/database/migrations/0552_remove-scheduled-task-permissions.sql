-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Schedules use Projects permissions. Retire frozen custom-role entries without
-- granting broader access to project files, instructions or private sessions.
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'scheduledTask')::text
WHERE "permission"::jsonb ? 'scheduledTask';
--> statement-breakpoint
-- The standalone organization-wide schedule policy has no consumer now.
-- Existing Project policies remain authoritative; do not widen their grants.
DELETE FROM "resource_permission_policies"
WHERE "resource" = 'scheduledTask';
