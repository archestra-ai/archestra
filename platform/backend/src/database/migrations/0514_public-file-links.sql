-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All constraints and indexes target the empty public_file_links table created in this migration. No existing rows need deduplication or validation, and no existing writer is blocked by these indexes. The check constraint is declared inline on the new table. The organization column is added with a constant default, which is metadata-only.
CREATE TABLE "public_file_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"token" text NOT NULL,
	"file_id" uuid,
	"created_by_user_id" text,
	"agent_id" uuid,
	"conversation_id" uuid,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_provider" text DEFAULT 'db' NOT NULL,
	"data" "bytea",
	"object_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "public_file_links_storage_payload_chk" CHECK ((
        ("public_file_links"."storage_provider" = 'db' AND "public_file_links"."object_key" IS NULL)
        OR ("public_file_links"."storage_provider" <> 'db' AND "public_file_links"."data" IS NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "allow_public_file_sharing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "public_file_links" ADD CONSTRAINT "public_file_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_file_links" ADD CONSTRAINT "public_file_links_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_file_links" ADD CONSTRAINT "public_file_links_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_file_links" ADD CONSTRAINT "public_file_links_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_file_links" ADD CONSTRAINT "public_file_links_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "public_file_links_token_idx" ON "public_file_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "public_file_links_org_created_at_idx" ON "public_file_links" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "public_file_links_file_id_idx" ON "public_file_links" USING btree ("file_id");