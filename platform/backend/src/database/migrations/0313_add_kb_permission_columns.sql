ALTER TABLE "kb_documents" ADD COLUMN "permission_sync_status" text DEFAULT 'synced' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "permission_sync_metadata" jsonb;