CREATE TABLE "agent_access_control" (
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_access_control_agent_id_user_id_pk" PRIMARY KEY("agent_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_access_control" ADD CONSTRAINT "agent_access_control_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_control" ADD CONSTRAINT "agent_access_control_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;