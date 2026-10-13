-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=swaps the conversation FK from SET NULL to CASCADE so retention deletes a conversation's sandboxes; running code never relies on the nulled reference.
ALTER TABLE "skill_sandboxes" DROP CONSTRAINT "skill_sandboxes_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD CONSTRAINT "skill_sandboxes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" VALIDATE CONSTRAINT "skill_sandboxes_conversation_id_conversations_id_fk";
