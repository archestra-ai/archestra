ALTER TABLE "memory_item" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "source_metadata" jsonb;--> statement-breakpoint
CREATE INDEX "memory_items_source_type_idx" ON "memory_item" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "memory_items_source_type_id_idx" ON "memory_item" USING btree ("source_type","source_id");