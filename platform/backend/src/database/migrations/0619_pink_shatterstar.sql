ALTER TABLE "guardrails_deployment" ADD COLUMN "human_approval_mode" varchar(16) DEFAULT 'unattended' NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD COLUMN "unapprovable_block_mode" varchar(16) DEFAULT 'refuse' NOT NULL;--> statement-breakpoint
ALTER TABLE "openappa_yells" ADD COLUMN "kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "openappa_yells" ADD COLUMN "count" integer DEFAULT 1 NOT NULL;