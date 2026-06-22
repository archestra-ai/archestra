-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All FKs and unique indexes target app_builder_conversations, a table created empty in this same migration, so validation/uniqueness scans no existing rows. ON DELETE cascade is intentional: a builder binding is meaningless without its conversation, app, or editor, and a deleted conversation/app/user should sever the binding.
CREATE TABLE "app_builder_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"app_id" uuid,
	"editor_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_builder_conversations" ADD CONSTRAINT "app_builder_conversations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_conversations" ADD CONSTRAINT "app_builder_conversations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_conversations" ADD CONSTRAINT "app_builder_conversations_editor_user_id_user_id_fk" FOREIGN KEY ("editor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_builder_conversations_conversation_id_idx" ON "app_builder_conversations" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "app_builder_conversations_app_id_idx" ON "app_builder_conversations" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_builder_conversations_app_editor_idx" ON "app_builder_conversations" USING btree ("app_id","editor_user_id") WHERE "app_builder_conversations"."app_id" IS NOT NULL;