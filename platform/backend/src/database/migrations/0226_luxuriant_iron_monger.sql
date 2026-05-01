ALTER TABLE "kb_uploaded_files" ADD COLUMN "processing_status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_uploaded_files" ADD COLUMN "processing_error" text;