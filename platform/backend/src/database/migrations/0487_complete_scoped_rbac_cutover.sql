-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Retiring `admin` and `team-admin` from roles runs in the same startup
-- transaction that converts their authority into scoped grants.
SELECT 1;
