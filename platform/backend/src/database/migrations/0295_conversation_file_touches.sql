-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both FK constraints target conversation_file_touches, a table created empty in this same migration, so validation scans no existing rows and the add-validating-constraint rule does not apply. ON DELETE cascade is intentional (touch rows are meaningless without their parent conversation/file).
CREATE TABLE "conversation_file_touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"touch_kind" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_file_touches_conversation_file_uq" UNIQUE("conversation_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_file_touches" ADD CONSTRAINT "conversation_file_touches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_file_touches" ADD CONSTRAINT "conversation_file_touches_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_file_touches_conversation_id_idx" ON "conversation_file_touches" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_file_touches_file_id_idx" ON "conversation_file_touches" USING btree ("file_id");