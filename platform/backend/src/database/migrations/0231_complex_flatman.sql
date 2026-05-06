CREATE TABLE "kb_uploaded_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"file_data" "bytea" NOT NULL,
	"processing_status" text DEFAULT 'completed' NOT NULL,
	"processing_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_uploaded_files" ADD CONSTRAINT "kb_uploaded_files_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_uploaded_files_connector_id_idx" ON "kb_uploaded_files" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_uploaded_files_content_hash_uidx" ON "kb_uploaded_files" USING btree ("connector_id","content_hash");