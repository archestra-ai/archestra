CREATE TABLE "a2a_context_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"boundary_message_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"original_token_estimate" integer NOT NULL,
	"compacted_token_estimate" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatops_thread_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"channel_id" varchar(256) NOT NULL,
	"workspace_id" varchar(256),
	"thread_id" varchar(256) NOT NULL,
	"context_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chatops_thread_contexts_thread_key_uq" UNIQUE NULLS NOT DISTINCT("provider","channel_id","workspace_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "a2a_context_compactions" ADD CONSTRAINT "a2a_context_compactions_context_id_a2a_context_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."a2a_context"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "a2a_context_compactions" VALIDATE CONSTRAINT "a2a_context_compactions_context_id_a2a_context_id_fk";--> statement-breakpoint
ALTER TABLE "a2a_context_compactions" ADD CONSTRAINT "a2a_context_compactions_boundary_message_id_a2a_message_id_fk" FOREIGN KEY ("boundary_message_id") REFERENCES "public"."a2a_message"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "a2a_context_compactions" VALIDATE CONSTRAINT "a2a_context_compactions_boundary_message_id_a2a_message_id_fk";--> statement-breakpoint
ALTER TABLE "chatops_thread_contexts" ADD CONSTRAINT "chatops_thread_contexts_context_id_a2a_context_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."a2a_context"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "chatops_thread_contexts" VALIDATE CONSTRAINT "chatops_thread_contexts_context_id_a2a_context_id_fk";--> statement-breakpoint
CREATE INDEX "a2a_context_compactions_context_id_created_at_idx" ON "a2a_context_compactions" USING btree ("context_id","created_at");--> statement-breakpoint
CREATE INDEX "chatops_thread_contexts_context_id_idx" ON "chatops_thread_contexts" USING btree ("context_id");