CREATE TABLE "agent_excluded_subagents" (
	"agent_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_excluded_subagents_agent_id_target_agent_id_pk" PRIMARY KEY("agent_id","target_agent_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "access_all_subagents" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_excluded_subagents" ADD CONSTRAINT "agent_excluded_subagents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_excluded_subagents" ADD CONSTRAINT "agent_excluded_subagents_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;