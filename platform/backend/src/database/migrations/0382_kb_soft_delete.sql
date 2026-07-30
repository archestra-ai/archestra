ALTER TABLE "knowledge_base_connectors" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "deleted_at" timestamp;