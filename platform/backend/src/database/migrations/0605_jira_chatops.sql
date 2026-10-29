-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All constraints and indexes target the three Jira ChatOps tables created empty in this migration. Existing rows cannot violate them; the changes are additive and older writers ignore these tables.
CREATE TABLE "jira_chatops_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"issue_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"body_digest" text NOT NULL,
	"method" text DEFAULT 'create' NOT NULL,
	"comment_id" text,
	"post_attempted" boolean DEFAULT false NOT NULL,
	"claim_id" uuid,
	"claimed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "jira_chatops_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"event_key" text NOT NULL,
	"delivery_id" text,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claim_id" uuid,
	"claimed_at" timestamp,
	"dispatched_at" timestamp,
	"task_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "jira_chatops_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" varchar(256) NOT NULL,
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jira_chatops_events" ADD CONSTRAINT "jira_chatops_events_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_chatops_identities" ADD CONSTRAINT "jira_chatops_identities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jira_chatops_deliveries_operation_idx" ON "jira_chatops_deliveries" USING btree ("integration_id","bot_id","operation_key");--> statement-breakpoint
CREATE INDEX "jira_chatops_deliveries_issue_idx" ON "jira_chatops_deliveries" USING btree ("integration_id","bot_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jira_chatops_events_revision_idx" ON "jira_chatops_events" USING btree ("integration_id","bot_id","event_key");--> statement-breakpoint
CREATE INDEX "jira_chatops_events_status_idx" ON "jira_chatops_events" USING btree ("integration_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "jira_chatops_identities_account_idx" ON "jira_chatops_identities" USING btree ("integration_id","account_id");