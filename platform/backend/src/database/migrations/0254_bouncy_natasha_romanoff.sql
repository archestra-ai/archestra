ALTER TABLE "kb_uploaded_files" ALTER COLUMN "file_data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_uploaded_files" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "kb_uploaded_files" ADD COLUMN "visibility" text DEFAULT 'org' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_uploaded_files" ADD COLUMN "team_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_uploaded_files" ADD COLUMN "blob_storage_provider" text;--> statement-breakpoint
ALTER TABLE "kb_uploaded_files" ADD COLUMN "blob_storage_key" text;--> statement-breakpoint
CREATE INDEX "kb_uploaded_files_organization_id_idx" ON "kb_uploaded_files" USING btree ("organization_id");