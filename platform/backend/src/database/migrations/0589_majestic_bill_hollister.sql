CREATE TABLE "proxy_provider_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_binding" text NOT NULL,
	"upstream_file_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"purpose" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "proxy_provider_files_scope_idx" ON "proxy_provider_files" USING btree ("organization_id","principal_kind","principal_id","provider","account_binding");