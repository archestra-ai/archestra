ALTER TABLE "agent_tools" ADD COLUMN "policies_auto_configured_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "policies_auto_configuring_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "policies_auto_configured_reasoning" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "auto_configure_new_tools" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interactions_user_id_idx" ON "interactions" USING btree ("user_id");