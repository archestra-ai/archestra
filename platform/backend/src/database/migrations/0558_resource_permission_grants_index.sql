-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Bound deployment waits while adding the grant lookup index.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE INDEX "resource_permission_policies_grants_idx" ON "resource_permission_policies" USING gin ("grants" jsonb_path_ops);