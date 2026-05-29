CREATE TABLE IF NOT EXISTS "conversation_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"file_data" "bytea" NOT NULL,
	"text_preview" text,
	"text_preview_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'conversation_attachments_conversation_id_conversations_id_fk'
	) THEN
		ALTER TABLE "conversation_attachments"
			ADD CONSTRAINT "conversation_attachments_conversation_id_conversations_id_fk"
			FOREIGN KEY ("conversation_id")
			REFERENCES "public"."conversations"("id")
			ON DELETE cascade
			ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_attachments_conversation_id_idx" ON "conversation_attachments" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_attachments_org_created_at_idx" ON "conversation_attachments" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_attachments_conversation_id_content_hash_live_uidx" ON "conversation_attachments" USING btree ("conversation_id","content_hash") WHERE "conversation_attachments"."deleted_at" IS NULL;
