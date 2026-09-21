-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Retiring `admin` and `team-admin` from roles also moved to
-- `services/resource-permissions-cutover.ts`, and for a sharper reason: those
-- actions are what the retired code paths authorize with. Removing them from a
-- deployment that still answers from visibility fields would take admin
-- authority away with nothing to replace it.
SELECT 1;
