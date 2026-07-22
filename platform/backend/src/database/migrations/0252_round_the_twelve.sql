CREATE TABLE "chat_active_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"payloads" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_active_run_events_run_id_seq_uidx" UNIQUE("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "chat_active_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"status" text NOT NULL,
	"stop_requested_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_active_run_events" ADD CONSTRAINT "chat_active_run_events_run_id_chat_active_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."chat_active_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_active_runs" ADD CONSTRAINT "chat_active_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_active_runs_conversation_id_idx" ON "chat_active_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_active_runs_running_conversation_uidx" ON "chat_active_runs" USING btree ("conversation_id") WHERE "chat_active_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "chat_active_runs_running_updated_at_idx" ON "chat_active_runs" USING btree ("updated_at") WHERE "chat_active_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "chat_active_runs_terminal_updated_at_idx" ON "chat_active_runs" USING btree ("updated_at") WHERE "chat_active_runs"."status" != 'running';