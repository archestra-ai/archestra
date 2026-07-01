ALTER TABLE "connector_runs" ADD COLUMN "pruned_documents" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "last_seen_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "last_prune_at" timestamp;