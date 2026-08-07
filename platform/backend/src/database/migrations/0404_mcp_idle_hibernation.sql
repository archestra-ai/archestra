-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- SPDX-FileCopyrightText: 2026 Archestra Inc.
ALTER TABLE "mcp_server" ADD COLUMN "last_used_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "hibernation_mode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "mcp_idle_hibernation_enabled" boolean DEFAULT false NOT NULL;