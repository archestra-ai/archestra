-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- The conversion from visibility fields to grants moved to the startup
-- routine in `services/resource-permissions-cutover.ts`.
--
-- The backend converts each policy once after schema migration, so sharing
-- and role authority move together in one transaction. Later permission edits
-- remain authoritative across restarts.
SELECT 1;
