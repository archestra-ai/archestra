-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=agent_run_shares, agent_run_share_team, and agent_run_share_user are all created empty in this same migration, so every validating FK and the task_id UNIQUE constraint match zero existing rows and cannot fail. ON DELETE cascade is intentional: a share's team/user rows are part of the share and must not outlive it, and a share must not outlive the a2a_task it grants read access to. All statements are O(1) catalog work on brand-new tables holding only short table-level locks, so there is no scan or write-blocking concern.
CREATE TYPE "public"."agent_run_share_visibility" AS ENUM('organization', 'team', 'user');--> statement-breakpoint
CREATE TABLE "agent_run_share_team" (
	"share_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_share_team_share_id_team_id_pk" PRIMARY KEY("share_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "agent_run_share_user" (
	"share_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_share_user_share_id_user_id_pk" PRIMARY KEY("share_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_run_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"visibility" "agent_run_share_visibility" DEFAULT 'organization' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_shares_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
ALTER TABLE "agent_run_share_team" ADD CONSTRAINT "agent_run_share_team_share_id_agent_run_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."agent_run_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_share_team" ADD CONSTRAINT "agent_run_share_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_share_user" ADD CONSTRAINT "agent_run_share_user_share_id_agent_run_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."agent_run_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_share_user" ADD CONSTRAINT "agent_run_share_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_shares" ADD CONSTRAINT "agent_run_shares_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;