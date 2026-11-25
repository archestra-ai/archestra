ALTER TABLE "guardrails_deployment" ADD COLUMN "mode" varchar(16);--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD COLUMN "person_approval" varchar(16);--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD COLUMN "enforced_marks" text[];