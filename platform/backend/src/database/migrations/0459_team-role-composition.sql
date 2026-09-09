-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
ALTER TABLE "team" ADD COLUMN "roles" text[] DEFAULT '{}' NOT NULL;