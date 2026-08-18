ALTER TABLE "schedule_triggers" ALTER COLUMN "cron_expression" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD COLUMN "run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD CONSTRAINT "schedule_triggers_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "schedule_triggers_conversation_id_idx" ON "schedule_triggers" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD CONSTRAINT "schedule_triggers_cron_or_run_at_chk" CHECK ((cron_expression IS NOT NULL) <> (run_at IS NOT NULL)) NOT VALID;