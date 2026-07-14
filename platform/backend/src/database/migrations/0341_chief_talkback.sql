-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- SPDX-FileCopyrightText: 2026 Archestra Inc.
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All flagged statements are rollout-safe: the FKs and unique indexes are on kb_external_user_groups, kb_member_overrides, and kb_container_acls — brand-new empty tables created in this same migration (nothing to validate or lock). The connector_runs single-flight index is replaced by a strictly-narrower composite (connector_id, run_type) — old writers only ever set run_type='content' (the default), so their content-run single-flight guarantee is preserved with no dedupe risk. The dropped kb_chunks_acl_idx has never served a query — it is a jsonb_path_ops GIN index while the only ACL filter uses the `?|` operator, which that operator class cannot serve.
CREATE TABLE "kb_container_acls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"container_key" text NOT NULL,
	"acl" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint" text,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_external_user_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"connector_type" text NOT NULL,
	"group_id" text NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text,
	"member_email" text,
	"account_type" text,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_member_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"external_account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "connector_runs_one_running_per_connector_idx";--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "run_type" text DEFAULT 'content' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "container_key" text;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "permission_sync_interval_seconds" integer DEFAULT 1800 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "last_permission_sync_at" timestamp;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "last_permission_sync_status" text;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "permission_sync_state" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "acl_config_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "kb_container_acls" ADD CONSTRAINT "kb_container_acls_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_external_user_groups" ADD CONSTRAINT "kb_external_user_groups_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_member_overrides" ADD CONSTRAINT "kb_member_overrides_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_member_overrides" ADD CONSTRAINT "kb_member_overrides_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_container_acls_connector_key_idx" ON "kb_container_acls" USING btree ("connector_id","container_key");--> statement-breakpoint
CREATE INDEX "kb_container_acls_acl_gin_idx" ON "kb_container_acls" USING gin ("acl");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_external_user_groups_unique_idx" ON "kb_external_user_groups" USING btree ("connector_id","group_id","external_account_id");--> statement-breakpoint
CREATE INDEX "kb_external_user_groups_member_email_idx" ON "kb_external_user_groups" USING btree ("member_email");--> statement-breakpoint
CREATE INDEX "kb_external_user_groups_connector_id_idx" ON "kb_external_user_groups" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_member_overrides_unique_idx" ON "kb_member_overrides" USING btree ("connector_id","external_account_id");--> statement-breakpoint
CREATE INDEX "kb_member_overrides_user_id_idx" ON "kb_member_overrides" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_runs_one_running_per_connector_run_type_idx" ON "connector_runs" USING btree ("connector_id","run_type") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "kb_documents_container_idx" ON "kb_documents" USING btree ("connector_id","container_key");--> statement-breakpoint
-- kb_chunks_acl_idx (raw GIN from 0168, never in the Drizzle schema) is dead
-- weight: it was built with jsonb_path_ops, which cannot serve the `?|`
-- operator the ACL filter uses, so no query has ever been served by it. With
-- container ACLs, chunk acl arrays shrink to a few entries and the residual
-- per-row filter needs no index at all.
DROP INDEX IF EXISTS "kb_chunks_acl_idx";