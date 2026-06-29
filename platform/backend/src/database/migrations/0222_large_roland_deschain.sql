CREATE TABLE "chatops_thread_agent_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"thread_id" varchar(256) NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chatops_thread_agent_override" ADD CONSTRAINT "chatops_thread_agent_override_binding_id_chatops_channel_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."chatops_channel_binding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatops_thread_agent_override" ADD CONSTRAINT "chatops_thread_agent_override_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chatops_thread_override_binding_thread_idx" ON "chatops_thread_agent_override" USING btree ("binding_id","thread_id");--> statement-breakpoint
CREATE INDEX "chatops_thread_override_agent_id_idx" ON "chatops_thread_agent_override" USING btree ("agent_id");