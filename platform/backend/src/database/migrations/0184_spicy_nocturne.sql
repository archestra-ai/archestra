CREATE TABLE "agent_suggested_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"summary_title" text NOT NULL,
	"prompt" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tools" DROP CONSTRAINT "tools_mcp_server_id_mcp_server_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "scope" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "scope" SET DEFAULT 'personal';--> statement-breakpoint
ALTER TABLE "agent_suggested_prompts" ADD CONSTRAINT "agent_suggested_prompts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_suggested_prompts_agent_id_idx" ON "agent_suggested_prompts" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "response_modifier_template";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "is_demo";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "user_prompt";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "prompt_version";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "prompt_history";--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN "mcp_server_id";--> statement-breakpoint
DROP TYPE "public"."agent_scope";