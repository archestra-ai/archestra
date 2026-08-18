CREATE TABLE "mcp_deployment_leases" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "mcp_deployment_leases_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
-- SPDX-SnippetBegin
-- SPDX-SnippetCopyrightText: 2026 Archestra Inc.
-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
ALTER TABLE "mcp_server" ADD COLUMN "last_used_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "hibernation_mode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "mcp_idle_hibernation_enabled" boolean DEFAULT false NOT NULL;
-- SPDX-SnippetEnd
